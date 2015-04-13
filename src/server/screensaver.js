var Logger = require('./logger');
var Options = require('./options');

var Screensaver = function(opts) {
  this.opts = new Options(opts);
  this.id = null;
  this.isSleeping = false;
};

Screensaver.prototype.check = function() {
  if (this.isSleeping) {
    this.isSleeping = false;
    Logger.info("Stopping screensaver");
    if (this.opts.wakeCallback) {
      this.opts.wakeCallback();
    }
  }
  if (this.id) {
    clearTimeout(this.id);
    this.id = null;
  }
  var that = this;
  this.id = setTimeout(function() {
    that.isSleeping = true;
    Logger.info("Starting screensaver");
    if (that.opts.sleepCallback) {
      that.opts.sleepCallback();
    }
  }, this.opts.timeout);
};

module.exports = Screensaver;


