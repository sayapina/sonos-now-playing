var http = require('http'),
  express = require('express'),
  logger = require('little-logger'),
  socketio = require('socket.io'),
  config = require('./config'),
  NotificationHandler = require('./notification-handler'),
  SonosController = require('./sonos-controller');

// The number of connected clients.
var connections = 0;

var options = config.getOptions();

var logger = new logger.Logger(options.loglevel, {
    format: '   %l  - %a'
});
var sonos = new SonosController(options, logger);
var notificationHandler = new NotificationHandler(logger, function(data) {
  io.sockets.emit('newTrack', data);
});

var app = express();
app.use(express.static('static'));
app.notify(options.callbackPath, function(req, res, next) {
  notificationHandler.handle(req, res, next);
});
app.get('/js/config.js', config.getHandler(options));
var server = app.listen(options.port);

var io = socketio.listen(server);
io.sockets.on('connection', function(socket) {

  connections++;
  if (connections === 1) {
    sonos.subscribe();
  }

  socket.on('play', function(data) {
    console.log('received PLAY');
  });

  socket.on('next', function(data) {
    console.log('received NEXT');
  });

  socket.on('disconnect', function() {
    connections--;
    if (connections === 0) {
      sonos.unsubscribe();
    }
  });
});
