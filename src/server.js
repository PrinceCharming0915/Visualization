'use strict';

// built in modules
var assert = require('assert');
var fs = require('fs');

// external deps
var binary = require('binary');
var staticServer = require('node-static');
var ws = require('ws');

// internal deps
var config = require('./config.js');

// allocate one block of ArrayBuffer for all histograms and extrema
var data = new ArrayBuffer(config.TOTAL_BYTES);
var histogram = require('./histogram.js')(data);

// start up ws server
var WebSocketServer = ws.Server
  , wss = new WebSocketServer({port: 8081});

var process = function(ws) {
  var closed = false;
  ws.on('close', function() {
    console.log('disconnected');
    closed = true;
  });
  fs.stat('bootstrap.dat', function(err, stats) {
    if (err) { throw err; }
    // start processing the file
    var totalFileSize = stats.size;
    var stream = fs.createReadStream('bootstrap.dat');
    var bytesRead = 0;
    var previousHundredthPct = 0;
    var b = binary()
      .loop(function(end, vars) {
        if (closed) {
          end();
          return;
        }
        this
          .word8lu('magic1')
          .word8lu('magic2')
          .word8lu('magic3')
          .word8lu('magic4')
          .word32lu('blockSizeWithHeader')
          .buffer('message', 'blockSizeWithHeader')
          .tap(function(vars) {
            // message length is in vars.size
            assert.equal(vars.magic1, 0xf9);
            assert.equal(vars.magic2, 0xbe);
            assert.equal(vars.magic3, 0xb4);
            assert.equal(vars.magic4, 0xd9);
            var pieces = binary.parse(vars.message)
              .buffer('header', 80)
              .buffer('nTx_varInt', 9)
              .vars;
            // parse out VAR_INT as described at
            // https://en.bitcoin.it/wiki/Protocol_specification#Variable_length_integer
            var nTx = null;
            var byte1 = binary.parse(pieces.nTx_varInt).word8lu('byte1').vars.byte1;
            if (byte1 < 0xfd) {
              nTx = byte1;
            } else if (byte1 === 0xfd) {
              nTx = binary.parse(pieces.nTx_varInt).skip(1).word16lu('nTx').vars.nTx;
            } else if (byte1 === 0xfe) {
              nTx = binary.parse(pieces.nTx_varInt).skip(1).word32lu('nTx').vars.nTx;
            } else {
              assert.equal(byte1, 0xff);
              nTx = binary.parse(pieces.nTx_varInt).skip(1).word64lu('nTx').vars.nTx;
            }

            // update histogram bins
            histogram.addValue('blockSize', vars.blockSizeWithHeader);
            histogram.addValue('numTransactions', nTx);

            // reporting
            bytesRead += (vars.blockSizeWithHeader + 8); // include header and magic bytes
            var hundredthPct = Math.floor((bytesRead / totalFileSize) * 10000);
            if (hundredthPct !== previousHundredthPct) {
              ws.send(new Buffer(new Uint8Array(data)));
              previousHundredthPct = hundredthPct;
              console.log((hundredthPct / 100) + '% complete');
            }
          });
      });
    stream.pipe(b);
  });
};

wss.on('connection', function(ws) {
  ws.on('message', function(message) {
    console.log('received: %s', message);
  });
  console.log('connected');
  process(ws);
});

// Create a node-static server instance to serve the '.' folder
var file = new staticServer.Server('.');
require('http').createServer(function (request, response) {
  request.addListener('end', function () {
    // Serve files!
    file.serve(request, response);
  }).resume();
}).listen(8080);
