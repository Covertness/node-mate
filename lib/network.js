var dgram = require("dgram")
  , events = require('events')
  , bencode = require('bencode')
  , inherits = require('inherits')
  , protocol = require('./protocol');


var Network = module.exports =
function Network(options) {
	var that = this;

	if (!(this instanceof Network)) {
		return new Network(options);
	}

	this.options = options;

	this.udpNode = dgram.createSocket("udp4");

	this.udpNode.on("error", function (err) {
		that.emit("net_error", err);
	});

	this.udpNode.on("close", function () {
		that.emit("net_close");
	});

	this.udpNode.on('listening', function () {
		that.emit("listening");
	});

	this.udpNode.on('message', function (data, remote) {
		try {
			var message = bencode.decode(data, 'utf8');
		} catch (e) {
			that.emit("data_error", 'decode error');
			console.log('Mate udp node reveive invalid message');
			return;
		}

		if (protocol.types[message.type] === undefined) {
			that.emit("data_error", 'unknown type');
			console.log('Mate udp node reveive invalid message');
			return;
		}

		console.log('Mate udp node reveive message type: ' + protocol.types[message.type]);

		var address = {
			ip: remote.address,
			port: remote.port
		};
		that.emit(protocol.types[message.type], message, address);
	});

	this.udpNode.bind(this.options.networkPort);
};
inherits(Network, events.EventEmitter);

Network.prototype.sendMessage = function (message, address) {
	console.log('Mate udp node send message type: ' + protocol.types[message.type]);

	var data = bencode.encode(message);
	this.udpNode.send(data, 0, data.length, address.port, address.ip, function (err, bytes) {
		if (err) {
			this.emit('send_error', err);
		}
	});
};

Network.prototype.close = function () {
	this.udpNode.close();
};