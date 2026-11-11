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
    return raw.split(/\r?\n/).filter(function (l) { return l.trim().indexOf('! U1') !== 0; }).join('\n');
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
    var matches = (customers || []).filter(function (name) {
      var k = normalize(name);
      return k && hay.indexOf(partial ? k : ' ' + k + ' ') !== -1;
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
   * opts.settings(): { customers, readTickets, counterVar, pollMs }
   * opts.onEvent(e): e.type is 'ticket' | 'reading' | 'log'
   * A transport has send(text) -> Promise and an onData(text) callback slot.
   */
  function Monitor(opts) {
    this.settings = opts.settings;
    this.emit = opts.onEvent || function () {};
    this.timing = Object.assign(
      { quietMs: 4000, rawFirstMs: 4000, rawIdleMs: 1000, tidyMs: 20 * 60 * 1000 },
      opts.timing
    );
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
    this.applyCapture();
    this.lastTidy = Date.now();
    if (this.pending > 0 && !this.jobT) this.armJob();   // job interrupted by a disconnect
    this.schedulePoll(50);
  };

  Monitor.prototype.stop = function () {
    this.running = false;
    clearTimeout(this.pollT);
    this.finishRaw();
  };

  /** Forget the counter, e.g. when switching printers. */
  Monitor.prototype.reset = function () {
    this.baseline = null;
    this.pending = 0;
    this.lastReading = null;
    clearTimeout(this.jobT);
    this.jobT = null;
  };

  Monitor.prototype.applyCapture = function () {
    if (!this.running) return;
    if (this.settings().readTickets) {
      // Capture switches itself off when the printer restarts, so this runs on every connect.
      this.send('! U1 setvar "input.capture" "run"\r\n');
    } else {
      this.send('! U1 setvar "input.capture" "off"\r\n');
      this.send('! U1 do "file.delete" "E:IN*.DMP"\r\n');
    }
  };

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
      var tidyDue = s.readTickets && !this.jobT && Date.now() - this.lastTidy > this.timing.tidyMs;
      if (tidyDue) this.readCaptured(true);
      else this.send('! U1 getvar "' + s.counterVar + '"\r\n');
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
    var m;
    while ((m = /"([^"]*)"/.exec(this.rx))) {
      this.rx = this.rx.slice(m.index + m[0].length);
      this.handleReading(m[1]);
    }
    if (this.rx.length > 4096) this.rx = '';
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
    if (!this.settings().readTickets) {
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
    return this.requestRaw('! U1 do "file.dir" "E:"\r\n')
      .then(function (listing) {
        files = captureFiles(listing);
        return files.reduce(function (p, f) {
          return p.then(function () {
            return self.requestRaw('! U1 do "file.type" "E:' + f + '"\r\n').then(function (c) { raw += '\n' + c; });
          });
        }, Promise.resolve());
      })
      .then(function () {
        if (!self.running) return false;
        var res = analyze(raw, self.settings().customers, { partial: self.settings().partial });
        if (tidy && res.hasJobData) return true;          // a ticket is arriving; leave it for the job read
        return files.reduce(function (p, f) {
          return p.then(function () { return self.send('! U1 do "file.delete" "E:' + f + '"\r\n'); });
        }, Promise.resolve()).then(function () {
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

  // ---------- Pretend printer, for the demo and the tests ----------

  /** Behaves like the ZD421 as far as this page can tell, including capturing our own commands. */
  function FakePrinter() {
    this.count = 1000;
    this.files = {};
    this.capture = false;
    this.onData = null;
  }

  FakePrinter.prototype.send = function (text) {
    var self = this;
    if (this.capture) this.append(text);
    text.split(/\r?\n/).forEach(function (line) {
      var m;
      if ((m = /getvar "([^"]+)"/.exec(line))) {
        self.reply('"' + self.count + '"');
      } else if ((m = /setvar "input\.capture" "(\w+)"/.exec(line))) {
        self.capture = m[1] === 'run';
      } else if (/do "file\.dir"/.test(line)) {
        var out = '- DIR E:*.*\r\n';
        Object.keys(self.files).forEach(function (f) { out += '* E:' + f + ' ' + self.files[f].length + '\r\n'; });
        self.reply(out + '- 62914560 bytes free E: ONBOARD FLASH\r\n');
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

  /** A ticket arriving over the network. */
  FakePrinter.prototype.print = function (data, labels) {
    if (this.capture) this.append(data + '\r\n');
    this.count += labels || 1;
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
    stripOwnCommands: stripOwnCommands, Monitor: Monitor, FakePrinter: FakePrinter
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TicketBell = api;
})(typeof self !== 'undefined' ? self : this);
