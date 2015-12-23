var Actions = require('./actions');
var config = require('./config');
var Coordinator = require('./coordinator');
var deepEqual = require('deep-equal');
var express = require('express');
var http = require('http');
var RecursiveXml2Js = require('./recursive-xml2js');
var Screensaver = require('./screensaver');
var socketio = require('socket.io');
var SonosEvent = require('./event');
var Logger = require('./logger');

// The number of connected clients.
var connections = 0;
var currentTrack = null;

var options = config.getOptions();

if (!('speakerIp' in options)) {
  Logger.error('Speaker IP not specified.');
  process.exit(1);
}

var getIsPlaying = function(state) {
  if (state === 'STOPPED' || state === 'PAUSED_PLAYBACK') {
    return false;
  } else if (state === 'PLAYING') {
    return true;
  }
  return null;
};

var screensaver = new Screensaver({
  timeout: 900,
});
screensaver.check();

var statusEvent = new SonosEvent({
  speakerIp: options.speakerIp,
  speakerPort: options.speakerPort,
  path: '/MediaRenderer/AVTransport/Event',
  callbackUrl: options.callbackUrl,
  handler: function(err, result) {
    if (err) {
      throw new Error(err);
    }

    var data = {};

    var source = result['e:propertyset']['e:property'].LastChange.Event.InstanceID;

    // Check for Sonos error. Note that if there is an error, the display may not match the
    // currently playing track (at least until the next update). How should we handle this?
    if (('TransportStatus' in source) && source.TransportStatus.val !== 'OK') {
      Logger.error(JSON.stringify(source));
      return;
    }

    var state = source.TransportState.val;
    data.transportState = state;

    if (state === 'STOPPED' || state === 'PAUSED_PLAYBACK') {
      data.isPlaying = false;
    } else if (state === 'PLAYING') {
      data.isPlaying = true;
    }

    var currentTrackMetaData = source.CurrentTrackMetaData.val;
    if (currentTrackMetaData) {
      var metadata = source.CurrentTrackMetaData.val['DIDL-Lite'].item;
      if ('dc:title' in metadata) {
        data.title = metadata['dc:title'];
      }
      if ('upnp:album' in metadata) {
        data.album = metadata['upnp:album'];
      }
      if ('dc:creator' in metadata) {
        data.artist = metadata['dc:creator'];
      }
      if ('upnp:albumArtURI' in metadata) {
        data.albumArt = 'http://' + options.speakerIp + ':' + options.speakerPort +
            metadata['upnp:albumArtURI'];
      }
    }

    if (deepEqual(currentTrack, data)) {
      // If new track equals the previous track, don't send an event to the user.
      return;
    }

    currentTrack = data;
    screensaver.check();
    Logger.info('New track', data);
    io.sockets.emit('newTrack', data);
  }
});

// Listens for any topology events.
var topologyEvent = new SonosEvent({
  speakerIp: options.speakerIp,
  speakerPort: options.speakerPort,
  path: '/ZoneGroupTopology/Event',
  callbackUrl: options.callbackUrl,
  handler: function(err, result) {
    if (err) {
      throw new Error(err);
    }
    setTimeout(function() {
      handleCoordinatorChange(result);
    }, 5000 // Waits 5 seconds to let multiple events flush through.
    );
  }
});
topologyEvent.subscribe();

var actions = new Actions({
  speakerIp: options.speakerIp,
  speakerPort: options.speakerPort});

var app = express();

app.use(express.static(__dirname + '/static'));

app.notify(options.callbackPath, function(req, res, next) {

  var body = '';
  req.on('data', function(chunk) {
    body += chunk.toString();
  });
  req.on('end', function() {
    // Respond to the request first so we don't keep Sonos waiting.
    res.writeHead(200);
    res.end();

    Logger.debug(body);

    var parser = new RecursiveXml2Js();
    parser.parse(body, function(err, result) {
      if (err) {
        throw new Error(err);
      }
      if ('LastChange' in result['e:propertyset']['e:property']) {
        statusEvent.handle(err, result);
      } else {
        // If this is not a track change event, assume it is a topology
        // change.
        topologyEvent.handle(err, result);
      }
    });
  });

});

app.get('/js/config.js', config.getHandler(options));

app.get('/refresh', function(req, res, next) {
  io.sockets.emit('refresh', {});
  res.writeHead(200);
  res.end();
});

app.get('/health', function(req, res, next) {
  res.writeHead(200);
  res.end('OK');
});

app.post('/error', function(req, res, next) {
  var body = '';
  req.on('data', function(chunk) {
    body += chunk.toString();
  });
  req.on('end', function() {
    res.writeHead(200);
    res.end();
    Logger.error('Client error', JSON.parse(body));
  });
});

var server = app.listen(options.port);

var io = socketio.listen(server);
io.sockets.on('connection', function(socket) {

  connections++;
  if (connections === 1) {
    statusEvent.subscribe();
  } else {
    // If this is not the first client, we are already subscribed to the
    // speaker, so just send back the track dadta.
    socket.emit('newTrack', currentTrack);
  }

  socket.on('play', function(data) {
    if (data.state) {
      actions.play();
    } else {
      actions.pause();
    }
  });

  socket.on('next', function(data) {
    actions.next();
  });

  socket.on('disconnect', function() {
    connections--;
    if (connections === 0) {
      statusEvent.unsubscribe();
      currentTrack = null;
    }
  });
});

// Runs in response to a "topology change" event.
var handleCoordinatorChange = function(result) {
  // Trying to parse the "topology change" response was too annoying and
  // complicted, so this just parses the updated topology file and grabs the
  // latest coordinator.
  var coordinator = new Coordinator({
    'speakerName': options.speakerName
  });
  coordinator.fromSpeakerIp(options.speakerIp, function(err, result) {
    if (err) {
      throw new Error(err);
    }

    if (result.ip === options.speakerIp) {
      // Coordinator did not change, do nothing.
      return;
    }

    Logger.info('Speaker IP changing from ' + options.speakerIp + ' to ' +
      result.ip);
  });
};

// Unsubscribe from existing subscriptions before existing.

var cleanedUp = false;
var beforeExit = function() {
  if (cleanedUp) {
    return;
  }
  cleanedUp = true;
  topologyEvent.unsubscribe(function() {
    if (connections > 0) {
      statusEvent.unsubscribe(function() {
        process.exit();
      });
    } else {
      process.exit();
    }
  });
};

process.stdin.resume();
process.on('SIGINT', beforeExit);
process.on('exit', beforeExit);
