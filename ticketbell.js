/* Ticket Bell core: reads ticket data, watches the printer's label counter,
   and reports each finished job. No page or Bluetooth code in here, so the
   same logic runs in the browser and in the Node tests. */
(function (root) {
  'use strict';

  // ---------- Reading ticket data ----------

  /** Lowercase, letters and digits only, single spaces: "O'Brien, J." -> "o brien j". */
  function normalize(s) {
    return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  /** The printer also captures the commands this page sends; drop them. */
  function stripOwnCommands(raw) {
    return raw.split(/\r?\n/).filter(function (l) {
      var t = l.trim();
      return t.indexOf('! U1') !== 0 && t !== '~HQES';
    }).join('\n');
  }

  // ---------- Printer health ----------

  var ERROR_FLAGS = [
    [0x1, 'Out of labels'], [0x2, 'Out of ribbon'], [0x4, 'Lid is open'], [0x8, 'Cutter fault'],
    [0x10, 'Printhead too hot'], [0x20, 'Motor too hot'], [0x40, 'Printhead element fault'],
    [0x80, 'Printhead not detected'], [0x100, 'Invalid firmware configuration'],
    [0x200, 'Printhead temperature sensor fault']
  ];
  var WARNING_FLAGS = [
    [0x1, 'Needs media calibration'], [0x2, 'Printhead needs cleaning'], [0x4, 'Printhead needs replacing']
  ];
  var STATUS_RE = /ERRORS:\s+(\d)\s+([0-9A-Fa-f]{8})\s+([0-9A-Fa-f]{8})[\s\S]*?WARNINGS:\s+(\d)\s+([0-9A-Fa-f]{8})\s+([0-9A-Fa-f]{8})/;

  function decodeFlags(group2, group1, table, unknown) {
    var out = [], known = 0;
    table.forEach(function (f) { known |= f[0]; if (group1 & f[0]) out.push(f[1]); });
    var rest = (group1 & ~known) >>> 0;
    if (rest || group2) {
      out.push(unknown + ' (code ' + ('0000000' + (group2 >>> 0).toString(16)).slice(-8) + ' ' +
        ('0000000' + rest.toString(16)).slice(-8) + ')');
    }
    return out;
  }

  /** Finds the printer's answer to ~HQES in a stream of text. Returns null until it has all arrived. */
  function parseStatus(text) {
    var m = STATUS_RE.exec(text);
    if (!m) return null;
    return {
      start: m.index,
      end: m.index + m[0].length,
      errors: decodeFlags(parseInt(m[2], 16), parseInt(m[3], 16), ERROR_FLAGS, 'Printer error'),
      warnings: decodeFlags(parseInt(m[5], 16), parseInt(m[6], 16), WARNING_FLAGS, 'Printer warning')
    };
  }

  // ---------- Ticket history ----------

  var KEEP_TICKETS_MS = 3 * 24 * 3600 * 1000;   // the ticket list, with its notes
  var KEEP_DAYS = 90;                           // daily totals for the stats

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function daysBefore(ms, days) {
    var d = new Date(ms);
    d.setHours(12, 0, 0, 0);            // midday, so clock changes can't skip or repeat a day
    d.setDate(d.getDate() - days);
    return d.getTime();
  }
  function newHistory() { return { tickets: [], days: {}, seq: 0 }; }

  /** ticket: { time, names, snippet }. Returns the stored entry. */
  function recordTicket(h, ticket) {
    h.seq = (h.seq || 0) + 1;
    var entry = {
      id: h.seq, time: ticket.time, names: ticket.names.slice(), snippet: ticket.snippet || '',
      done: false, doneAt: 0, note: ''
    };
    h.tickets.unshift(entry);
    var k = dayKey(ticket.time);
    var day = h.days[k];
    if (!day) {
      day = h.days[k] = { n: 0, w: 0, h: [], c: {} };
      for (var i = 0; i < 24; i++) day.h.push(0);
    }
    day.n++;
    if (ticket.names.length) day.w++;
    day.h[new Date(ticket.time).getHours()]++;
    ticket.names.forEach(function (name) { day.c[name] = (day.c[name] || 0) + 1; });
    pruneHistory(h, ticket.time);
    return entry;
  }

  function pruneHistory(h, now) {
    h.tickets = h.tickets.filter(function (t) { return now - t.time < KEEP_TICKETS_MS; });
    var cutoff = dayKey(daysBefore(now, KEEP_DAYS));
    Object.keys(h.days).forEach(function (k) { if (k < cutoff) delete h.days[k]; });
  }

  function historyStats(h, now) {
    var week = [], hours = [], weekTotal = 0, i;
    for (i = 0; i < 24; i++) hours.push(0);
    for (i = 6; i >= 0; i--) {
      var ms = daysBefore(now, i);
      var day = h.days[dayKey(ms)] || { n: 0, w: 0, h: [], c: {} };
      week.push({ key: dayKey(ms), time: ms, n: day.n, w: day.w });
      weekTotal += day.n;
      for (var hr = 0; hr < 24; hr++) hours[hr] += day.h[hr] || 0;
    }
    var counts = {};
    for (i = 0; i < 30; i++) {
      var d = h.days[dayKey(daysBefore(now, i))];
      if (d) Object.keys(d.c).forEach(function (name) { counts[name] = (counts[name] || 0) + d.c[name]; });
    }
    var top = Object.keys(counts).map(function (name) { return { name: name, count: counts[name] }; })
      .sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : 1); }).slice(0, 5);
    return {
      today: week[6], yesterday: week[5], week: week, weekTotal: weekTotal, hours: hours, top: top,
      waiting: h.tickets.filter(function (t) { return t.names.length && !t.done; }).length
    };
  }

  /** opts.partial: an entry also matches inside a longer word ("Smith" finds "Smithson"). */
  function analyze(raw, customers, opts) {
    var partial = !!(opts && opts.partial);
    var jobData = stripOwnCommands(raw);
    var fields = [];
    var re = /\^FD([^\^~]*)/gi, m;
    while ((m = re.exec(jobData))) {
      var t = m[1].trim();
      if (t) fields.push(t);
    }
    var upper = jobData.toUpperCase();
    var hasGraphics = ['^GF', '~DG', '~DY'].some(function (c) { return upper.indexOf(c) !== -1; });
    var isImage = fields.length === 0 && hasGraphics;
    // EPL, CPCL and plain-text jobs don't use ^FD, so fall back to searching everything.
    var text = fields.length ? fields.join('\n') : jobData.trim();
    var hay = ' ' + normalize(text) + ' ';
    // A customer is either a plain string, or { name, matches: [wordings that may appear on the label] }.
    // The result lists each matched customer's name once, however many of its wordings were found.
    var matches = [];
    (customers || []).forEach(function (c) {
      var name = typeof c === 'string' ? c : c && c.name;
      var wordings = typeof c === 'string' ? [c] : (c && c.matches && c.matches.length ? c.matches : [name]);
      var found = wordings.some(function (w) {
        var k = normalize(w || '');
        return k && hay.indexOf(partial ? k : ' ' + k + ' ') !== -1;
      });
      if (found && name && matches.indexOf(name) === -1) matches.push(name);
    });
    return {
      text: text.slice(0, 5000),
      isImage: isImage,
      matches: matches,
      hasJobData: jobData.trim().length > 0
    };
  }

  function captureFiles(listing) {
    var found = String(listing).toUpperCase().match(/IN\d{3}\.DMP/g) || [];
    return Array.from(new Set(found)).sort();
  }

  // ---------- Watching the printer ----------

  /**
   * opts.settings(): { customers, readTickets, healthAlerts, counterVar, pollMs }
   * opts.onEvent(e): e.type is 'ticket' | 'reading' | 'health' | 'memory' | 'lowmemory' | 'log'
   * A transport has send(text) -> Promise and an onData(text) callback slot.
   *
   * What this does to the printer:
   *  - asks for its label counter and its status (read-only questions);
   *  - if ticket reading is on, switches on "input capture", which makes the printer keep a
   *    copy of what it receives in files E:IN###.DMP. Those copies are deleted after every
   *    ticket, on a timer, on connect, and on disconnect, and capture is switched off if the
   *    printer's free memory gets low. Capture also switches itself off when the printer restarts.
   * Nothing else on the printer is changed.
   */
  var CAPTURE_ON = '! U1 setvar "input.capture" "run"\r\n';
  var CAPTURE_OFF = '! U1 setvar "input.capture" "off"\r\n';
  var DELETE_ALL = '! U1 do "file.delete" "E:IN*.DMP"\r\n';

  function Monitor(opts) {
    this.settings = opts.settings;
    this.emit = opts.onEvent || function () {};
    this.timing = Object.assign(
      { quietMs: 4000, rawFirstMs: 4000, rawIdleMs: 1000, tidyMs: 10 * 60 * 1000, fullTidyMs: 60 * 60 * 1000,
        staleMs: 20000, healthMs: 10000 },
      opts.timing
    );
    this.lowMemoryBytes = opts.lowMemoryBytes || 2000000;   // stop reading tickets below this much free memory
    this.tidyBytes = opts.tidyBytes || 200000;              // clear the copies once they pass this size
    this.lastFullTidy = Date.now();
    this.captureBlocked = false;   // set when the printer's memory got low
    this.staleSeen = false;
    this.hasErrors = false;
    this.healthKey = null;
    this.lastHealth = 0;
    this.transport = null;
    this.running = false;
    this.busy = false;
    this.rx = '';
    this.raw = null;
    this.baseline = null;
    this.pending = 0;
    this.lastReading = null;
    this.lastTidy = Date.now();
  }

  Monitor.prototype.attach = function (transport) {
    var self = this;
    this.transport = transport;
    transport.onData = function (s) { self.received(s); };
  };

  Monitor.prototype.start = function () {
    this.running = true;
    this.busy = false;
    this.rx = '';
    this.healthKey = null;      // report the printer's state afresh on every connect
    this.lastHealth = 0;
    this.staleSeen = false;
    // First connection of this session: clear out copies an earlier session may have left behind.
    this.applyCapture(this.baseline === null && this.pending === 0);
    // First routine check soon after connecting, so the page can show the printer's free memory.
    this.lastTidy = Date.now() - this.timing.tidyMs + Math.min(15000, this.timing.tidyMs);
    if (this.pending > 0 && !this.jobT) this.armJob();   // job interrupted by a disconnect
    this.schedulePoll(50);
  };

  /** Connection lost: stop asking, keep our place so we can catch up after reconnecting. */
  Monitor.prototype.stop = function () {
    this.running = false;
    clearTimeout(this.pollT);
    this.finishRaw();
  };

  /** Disconnecting on purpose: leave the printer as we found it. Resolves when the commands are sent. */
  Monitor.prototype.shutdown = function () {
    var self = this;
    clearTimeout(this.pollT);
    clearTimeout(this.jobT);
    this.jobT = null;
    this.pending = 0;
    this.finishRaw();
    this.running = false;
    return this.send(CAPTURE_OFF).then(function () { return self.send(DELETE_ALL); });
  };

  /** Forget the counter, e.g. when switching printers. */
  Monitor.prototype.reset = function () {
    this.baseline = null;
    this.pending = 0;
    this.lastReading = null;
    clearTimeout(this.jobT);
    this.jobT = null;
  };

  Monitor.prototype.applyCapture = function (clearFirst) {
    if (!this.running) return;
    var on = this.settings().readTickets && !this.captureBlocked;
    if (!on || clearFirst) {
      this.send(CAPTURE_OFF);
      this.send(DELETE_ALL);
    }
    // Capture switches itself off when the printer restarts, so this runs on every connect.
    if (on) this.send(CAPTURE_ON);
  };

  /** The user switched ticket reading back on: allow it again even after a low-memory stop. */
  Monitor.prototype.allowCapture = function () { this.captureBlocked = false; };

  Monitor.prototype.log = function (text) { this.emit({ type: 'log', text: text }); };

  Monitor.prototype.send = function (text) {
    var self = this;
    if (!this.transport) return Promise.resolve();
    return Promise.resolve()
      .then(function () { return self.transport.send(text); })
      .catch(function (e) { self.log('Send failed: ' + (e && e.message ? e.message : e)); });
  };

  Monitor.prototype.schedulePoll = function (ms) {
    var self = this;
    clearTimeout(this.pollT);
    if (!this.running) return;
    this.pollT = setTimeout(function () { self.poll(); }, ms);
  };

  Monitor.prototype.poll = function () {
    var s = this.settings();
    if (!this.busy) {
      var capturing = s.readTickets && !this.captureBlocked;
      var tidyDue = capturing && !this.jobT && this.pending === 0 &&
        Date.now() - this.lastTidy > this.timing.tidyMs;
      if (tidyDue) {
        this.readCaptured(true);
      } else {
        this.send('! U1 getvar "' + s.counterVar + '"\r\n');
        if (s.healthAlerts && Date.now() - this.lastHealth >= this.timing.healthMs) {
          this.lastHealth = Date.now();
          this.send('~HQES\r\n');
        }
      }
    }
    this.schedulePoll(s.pollMs);
  };

  Monitor.prototype.received = function (s) {
    if (this.raw) {
      this.raw.buf += s;
      if (this.raw.buf.length > 500000) this.finishRaw();
      else this.armRaw(this.timing.rawIdleMs);
      return;
    }
    this.rx += s;
    var status = parseStatus(this.rx);
    if (status) {
      this.rx = this.rx.slice(0, status.start) + this.rx.slice(status.end);
      this.handleHealth(status);
    }
    var m;
    while ((m = /"([^"]*)"/.exec(this.rx))) {
      this.rx = this.rx.slice(m.index + m[0].length);
      this.handleReading(m[1]);
    }
    if (this.rx.length > 4096) this.rx = '';
  };

  /** Reports printer problems only when they change. */
  Monitor.prototype.handleHealth = function (status) {
    this.hasErrors = status.errors.length > 0;
    var key = status.errors.join('|') + '#' + status.warnings.join('|');
    if (key === this.healthKey) return;
    var first = this.healthKey === null;
    this.healthKey = key;
    if (first && !status.errors.length && !status.warnings.length) return;   // healthy at connect: say nothing
    this.emit({ type: 'health', errors: status.errors, warnings: status.warnings });
  };

  Monitor.prototype.handleReading = function (value) {
    var changed = value !== this.lastReading;
    this.lastReading = value;
    this.emit({ type: 'reading', value: value });
    var m = /^\s*(\d[\d,]*)(\.\d+)?(\s*[A-Za-z]{0,12})?\s*$/.exec(value);
    if (!m) {
      if (changed) this.log('Printer answered "' + value + '" for ' + this.settings().counterVar + '. Try another counter setting.');
      return;
    }
    var n = parseInt(m[1].replace(/,/g, ''), 10);
    var old = this.baseline;
    this.baseline = n;
    if (old === null) { this.log('Watching ' + this.settings().counterVar + ' (now ' + n + ')'); return; }
    if (n > old) { this.pending += n - old; this.armJob(); }
  };

  /** Labels that print close together count as one job. */
  Monitor.prototype.armJob = function () {
    var self = this;
    var wait = Math.max(this.timing.quietMs, this.settings().pollMs + this.timing.quietMs / 2);
    clearTimeout(this.jobT);
    this.jobT = setTimeout(function () { self.jobT = null; self.finishJob(); }, wait);
  };

  Monitor.prototype.finishJob = function () {
    var self = this;
    if (!this.running) return Promise.resolve();          // finishes after reconnecting
    if (this.busy) { this.armJob(); return Promise.resolve(); }
    var count = this.pending;
    this.pending = 0;
    this.log('Ticket printed (counter +' + count + ')');
    if (!this.settings().readTickets || this.captureBlocked) {
      this.emit({ type: 'ticket', matches: [], text: '', raw: '', isImage: false, read: false });
      return Promise.resolve();
    }
    return this.readCaptured(false).then(function (done) {
      if (!done) self.pending += count;                   // lost the connection mid-read; retry later
    });
  };

  /**
   * Lists the printer's capture files, reads them, deletes them, and reports the ticket.
   * In tidy mode it only clears out captured copies of this page's own commands.
   */
  Monitor.prototype.readCaptured = function (tidy) {
    var self = this;
    this.busy = true;
    this.lastTidy = Date.now();
    var files = [];
    var raw = '';
    var free = null;
    var skipRead = false;
    return this.requestRaw('! U1 do "file.dir" "E:"\r\n')
      .then(function (listing) {
        files = captureFiles(listing);
        var fm = /(\d+)\s+bytes\s+free/i.exec(listing);
        if (fm) { free = parseInt(fm[1], 10); self.emit({ type: 'memory', free: free }); }
        if (tidy) {
          // A routine check only looks at the list. The copies are read and cleared only once they
          // have grown, which keeps the printer's workload low and makes it very unlikely that a
          // clean-up lands on the same second as an arriving ticket.
          var sizes = [], sm, sizeRe = /IN\d{3}\.DMP\s+(\d+)/gi;
          while ((sm = sizeRe.exec(listing))) sizes.push(parseInt(sm[1], 10));
          var total = sizes.length === files.length ? sizes.reduce(function (a, b) { return a + b; }, 0) : null;
          var grown = total !== null ? total > self.tidyBytes
                                     : Date.now() - self.lastFullTidy > self.timing.fullTidyMs;
          if (!grown && !self.staleSeen) { skipRead = true; return; }
        }
        self.lastFullTidy = Date.now();
        return files.reduce(function (p, f) {
          return p.then(function () {
            return self.requestRaw('! U1 do "file.type" "E:' + f + '"\r\n').then(function (c) { raw += '\n' + c; });
          });
        }, Promise.resolve());
      })
      .then(function () {
        if (!self.running) return false;
        if (skipRead) { self.checkMemory(free); return true; }
        var res = analyze(raw, self.settings().customers, { partial: self.settings().partial });
        if (tidy && res.hasJobData && (!self.staleSeen || self.hasErrors)) {
          // Probably a ticket that is arriving right now (or waiting on a printer problem), so leave it
          // for the ticket read. Look again shortly: if no ticket was counted by then it is a leftover,
          // and the next pass deletes it.
          self.staleSeen = true;
          self.lastTidy = Date.now() - self.timing.tidyMs + self.timing.staleMs;
          return true;
        }
        self.staleSeen = false;
        return files.reduce(function (p, f) {
          return p.then(function () { return self.send('! U1 do "file.delete" "E:' + f + '"\r\n'); });
        }, Promise.resolve()).then(function () {
          self.checkMemory(free);
          if (!tidy) {
            self.emit({
              type: 'ticket', matches: res.matches, text: res.text, isImage: res.isImage,
              raw: stripOwnCommands(raw).trim().slice(0, 20000), read: files.length > 0 && res.hasJobData
            });
          }
          return true;
        });
      })
      .then(function (done) { self.rx = ''; self.busy = false; return done; },
            function (e) { self.rx = ''; self.busy = false; self.log('Read failed: ' + e); return false; });
  };

  /** Safety stop: never let ticket copies fill the printer. */
  Monitor.prototype.checkMemory = function (free) {
    if (free === null || free >= this.lowMemoryBytes || this.captureBlocked) return;
    if (!this.settings().readTickets) return;
    this.captureBlocked = true;
    this.send(CAPTURE_OFF);
    this.send(DELETE_ALL);
    this.emit({ type: 'lowmemory', free: free });
  };

  Monitor.prototype.requestRaw = function (command) {
    var self = this;
    if (!this.running) return Promise.resolve('');
    return new Promise(function (resolve) {
      self.raw = { buf: '', resolve: resolve };
      self.send(command);
      self.armRaw(self.timing.rawFirstMs);
    });
  };

  Monitor.prototype.armRaw = function (ms) {
    var self = this;
    clearTimeout(this.rawT);
    this.rawT = setTimeout(function () { self.finishRaw(); }, ms);
  };

  Monitor.prototype.finishRaw = function () {
    clearTimeout(this.rawT);
    var r = this.raw;
    if (!r) return;
    this.raw = null;
    r.resolve(r.buf);
  };

  // ---------- Announcement queue ----------

  /**
   * Announces each name a fixed number of times with a quiet gap between rounds,
   * then closes by itself. Names that arrive while a round is playing join the
   * next round, so several tickets share one announcement instead of overlapping.
   *
   * opts.play(names) -> Promise that resolves when the sound has finished
   * opts.onShow(names), opts.onDone()
   * opts.settings(): { times, gapMs, lingerMs }
   */
  function Announcer(opts) {
    this.play = opts.play;
    this.onShow = opts.onShow || function () {};
    this.onDone = opts.onDone || function () {};
    this.settings = opts.settings;
    this.entries = [];
    this.active = false;
    this.gen = 0;
    this.timer = null;
  }

  Announcer.prototype.names = function () { return this.entries.map(function (e) { return e.name; }); };

  Announcer.prototype.add = function (names) {
    var self = this;
    var times = Math.max(1, this.settings().times || 1);
    names.forEach(function (n) {
      var existing = self.entries.filter(function (e) { return e.name === n; })[0];
      if (existing) existing.left = times;
      else self.entries.push({ name: n, left: times });
    });
    this.onShow(this.names());
    if (!this.active) this.round();
  };

  Announcer.prototype.round = function () {
    var self = this, gen = this.gen;
    this.active = true;
    var batch = this.entries.filter(function (e) { return e.left > 0; });
    batch.forEach(function (e) { e.left--; });
    var after = function () {
      if (gen !== self.gen) return;                       // dismissed meanwhile
      var more = self.entries.some(function (e) { return e.left > 0; });
      var s = self.settings();
      self.timer = setTimeout(function () {
        if (gen !== self.gen) return;
        // A name may have arrived during the closing pause.
        if (self.entries.some(function (e) { return e.left > 0; })) self.round();
        else self.dismiss();
      }, more ? s.gapMs : (s.lingerMs || 0));
    };
    Promise.resolve()
      .then(function () { return self.play(batch.map(function (e) { return e.name; })); })
      .then(after, after);
  };

  /** Stop everything now (also used when the last round has finished). */
  Announcer.prototype.dismiss = function () {
    this.gen++;
    clearTimeout(this.timer);
    this.entries = [];
    this.active = false;
    this.onDone();
  };

  // ---------- Pretend printer, for the demo and the tests ----------

  /** Behaves like the ZD421 as far as this page can tell, including capturing our own commands. */
  function FakePrinter() {
    this.count = 1000;
    this.files = {};
    this.capture = false;
    this.onData = null;
    this.errorBits = 0;          // e.g. 0x1 out of labels, 0x4 lid open
    this.warningBits = 0;
    this.waiting = 0;            // labels received but not printed because of a problem
    this.flashBytes = 62914560;  // free space with no capture files
  }

  FakePrinter.prototype.freeBytes = function () {
    var self = this;
    return this.flashBytes - Object.keys(this.files).reduce(function (n, f) { return n + self.files[f].length; }, 0);
  };

  FakePrinter.prototype.send = function (text) {
    var self = this;
    if (this.capture) this.append(text);
    text.split(/\r?\n/).forEach(function (line) {
      var m;
      if (line.trim() === '~HQES') {
        var hex = function (n) { return ('0000000' + n.toString(16)).slice(-8); };
        self.reply('\x02\r\n  PRINTER STATUS\r\n   ERRORS:         ' + (self.errorBits ? 1 : 0) + ' 00000000 ' +
          hex(self.errorBits) + '\r\n   WARNINGS:       ' + (self.warningBits ? 1 : 0) + ' 00000000 ' +
          hex(self.warningBits) + '\r\n\x03');
      } else if ((m = /getvar "([^"]+)"/.exec(line))) {
        self.reply('"' + self.count + '"');
      } else if ((m = /setvar "input\.capture" "(\w+)"/.exec(line))) {
        self.capture = m[1] === 'run';
      } else if (/do "file\.dir"/.test(line)) {
        var out = '- DIR E:*.*\r\n';
        Object.keys(self.files).forEach(function (f) { out += '* E:' + f + ' ' + self.files[f].length + '\r\n'; });
        self.reply(out + '- ' + self.freeBytes() + ' bytes free E: ONBOARD FLASH\r\n');
      } else if ((m = /do "file\.type" "E:([^"]+)"/.exec(line))) {
        self.reply(self.files[m[1]] || '');
      } else if ((m = /do "file\.delete" "E:([^"]+)"/.exec(line))) {
        var pattern = new RegExp('^' + m[1].replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        Object.keys(self.files).forEach(function (f) { if (pattern.test(f)) delete self.files[f]; });
      }
    });
    return Promise.resolve();
  };

  FakePrinter.prototype.append = function (text) {
    this.files['IN001.DMP'] = (this.files['IN001.DMP'] || '') + text;
  };

  /** A ticket arriving over the network. With a printer problem it is received but can't print yet. */
  FakePrinter.prototype.print = function (data, labels) {
    if (this.capture) this.append(data + '\r\n');
    if (this.errorBits) this.waiting += labels || 1;
    else this.count += labels || 1;
  };

  /** Set or clear a problem. Clearing it prints whatever was waiting. */
  FakePrinter.prototype.setProblem = function (errorBits) {
    this.errorBits = errorBits;
    if (!errorBits && this.waiting) { this.count += this.waiting; this.waiting = 0; }
  };

  FakePrinter.prototype.reply = function (text) {
    var self = this;
    setTimeout(function () {
      for (var i = 0; i < text.length; i += 20) {
        if (self.onData) self.onData(text.slice(i, i + 20));
      }
    }, 5);
  };

  var api = {
    normalize: normalize, analyze: analyze, captureFiles: captureFiles,
    stripOwnCommands: stripOwnCommands, parseStatus: parseStatus,
    newHistory: newHistory, recordTicket: recordTicket, pruneHistory: pruneHistory, historyStats: historyStats,
    dayKey: dayKey, Monitor: Monitor, Announcer: Announcer, FakePrinter: FakePrinter
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TicketBell = api;
})(typeof self !== 'undefined' ? self : this);
