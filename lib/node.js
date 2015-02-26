var KBucket = require('k-bucket')
  , uuid = require('uuid')
  , events = require('events')
  , inherits = require('inherits')
  , ht = require("ht")
  , Network = require('./network')
  , protocol = require('./protocol')
  , bufferEqual = require('buffer-equal');

var defaultOptions = {
	networkPort: 2015,
	maxClosestNodes: 2,
	lookupTimeout: 5,         // seconds
	directConnectTimeout: 5, // seconds
	pingInterval: 30          // seconds
};

var Node = module.exports = function(options) {
	var that = this;

	if (!(this instanceof Node)) {
		return new Node(options);
	}

	this.options = options || {};

	for(var k in defaultOptions) {
		if ('undefined' === typeof this.options[k]) {
			this.options[k] = defaultOptions[k];
		} else {
			this.options[k] = options[k];
		}
	}

	this.localNodeContact = {
		id: new Buffer(uuid.v1()),
		ip: require('my-local-ip')(),
		port: this.options.networkPort
	}

	this.routeBucket = new KBucket({
		localNodeId: this.localNodeContact.id
	});

	this.messageList = new ht();
	this.unavailableNodeList = new ht();

	events.EventEmitter.call(this);

	this._setupNetwork();
};
inherits(Node, events.EventEmitter);

Node.prototype.lookup = function(nodeId, callback) {
	var that = this;

	var nodeIdBin = new Buffer(nodeId);

	if (KBucket.distance(nodeIdBin, this.routeBucket.localNodeId) === 0) {
		callback(true, this.localNodeContact);
		return;
	}

	var lookupNode = this.routeBucket.get(nodeIdBin);
	if (lookupNode) {
		callback(true, lookupNode, this.localNodeContact);
		return;
	}

	lookupNode = {id: nodeIdBin};
	var closestNodes = this.routeBucket.closest(lookupNode, this.options.maxClosestNodes);
	if (closestNodes.length === 0) {
		callback(false);
		return;
	}

	if (this.unavailableNodeList.contains(nodeId)) {
		callback(false);
		return;
	}

	console.log('lookup begin: nodeId ' + nodeId);

	var lookupFailTimeout = setTimeout(function() {
		console.log('lookup failed: nodeId ' + nodeId);
		callback(false);

		that.unavailableNodeList.put(nodeId, setTimeout(function() {
			that.unavailableNodeList.remove(nodeId);
		}, that.options.maxClosestNodes * that.options.lookupTimeout * 1000));
	}, that.options.lookupTimeout * 1000);

	var sendLookupMessage = function(node) {
		if (KBucket.distance(node.id, that.routeBucket.localNodeId) === 0) {
			return;
		}

		var messageId = that._sendLookupMessage(nodeId, node);

		var messageHandlers = {
			type: protocol.typeCodes['mate_lookup'],
			findHandler: function(respNodeArray) {
				clearTimeout(messageHandlers.timeoutHandler);
				that.messageList.remove(messageId);

				var index = that._indexOfNodeArray(nodeIdBin, respNodeArray);
				if (index >= 0) {
					if (lookupFailTimeout) {
						clearTimeout(lookupFailTimeout);
						lookupFailTimeout = null;

						callback(true, respNodeArray[index], node);
					}
				} else {
					if (!that.unavailableNodeList.contains(nodeId)) {
						respNodeArray.forEach(sendLookupMessage);
					}
				}
			},
			timeoutHandler: setTimeout(function() {
				console.log('lookup timeout: messageId ' + messageId + 
					' nodeId ' + nodeId + 
					' routeNodeId ' + node.id.toString());
				that.messageList.remove(messageId);
			}, that.options.lookupTimeout * 1000)
		};

		that.messageList.put(messageId, messageHandlers);
	};

	closestNodes.forEach(sendLookupMessage);
};

Node.prototype.directConnect = function(nodeAddress, callback) {
	var that = this;

	var messageId = this._sendConnectMessage(nodeAddress);

	var messageHandlers = {
		type: protocol.typeCodes['mate_connect'],
		conackHandler: function(nodeId, remoteAddress) {
			clearTimeout(messageHandlers.timeoutHandler);
			that.messageList.remove(messageId);

			var nodeIdBin = new Buffer(nodeId);
			var existNode = that.routeBucket.get(nodeIdBin);
			if (!existNode) {
				that._addNode(nodeIdBin, remoteAddress);
				callback(true);
			} else {
				console.log('exist node: ' + nodeId);
				callback(false);
			}
		},
		timeoutHandler: setTimeout(function() {
			console.log('directConnect timeout: messageId ' + messageId +
				' nodeIp ' + nodeAddress.ip + ' nodePort ' + nodeAddress.port);
			that.messageList.remove(messageId);
			callback(false);
		}, that.options.directConnectTimeout * 1000)
	};

	that.messageList.put(messageId, messageHandlers);
};

Node.prototype.end = function() {
	this.network.close();
};

Node.prototype._setupNetwork = function() {
	var that = this;

	this.network = new Network(this.options);

	this.network.on('listening', this.emit.bind(this, 'listening'));

	this.network.on('net_error', this.emit.bind(this, 'net_error'));
	this.network.on('net_close', this.emit.bind(this, 'net_close'));

	this.network.on('mate_lookup', function(message, address) {
		that._handleLookupMessage(message, address);
	});
	this.network.on('mate_lookresp', function(message, address) {
		that._handleLookrespMessage(message, address);
	});
	this.network.on('mate_connect', function(message, address) {
		that._handleConnectMessage(message, address);
	});
	this.network.on('mate_conack', function(message, address) {
		that._handleConackMessage(message, address);
	});
	this.network.on('mate_ping', function(message, address) {
		that._handlePingMessage(message, address);
	});
};

Node.prototype._sendLookupMessage = function(lookupNodeId, remoteNode) {
	var lookupMessage = {
		type: protocol.typeCodes['mate_lookup'],
		messageId: uuid.v1(),
		lookupNodeId: lookupNodeId
	};
	this.network.sendMessage(lookupMessage, remoteNode.address);
	return lookupMessage.messageId;
};

Node.prototype._handleLookupMessage = function(message, address) {
	if (!message.lookupNodeId || !message.messageId) {
		console.log('lookup message missing parameters');
		return;
	}

	var lookupNode = {id: new Buffer(message.lookupNodeId)};
	var closestNodes = this.routeBucket.closest(lookupNode, this.options.maxClosestNodes);

	var lookrespMessage = {
		type: protocol.typeCodes['mate_lookresp'],
		messageId: message.messageId,
		closestNodes: this._serializeNodeArray(closestNodes)
	};
	this.network.sendMessage(lookrespMessage, address);
};

Node.prototype._handleLookrespMessage = function(message, address) {
	if (!message.closestNodes || message.closestNodes.constructor !== Array) {
		console.log('lookresp message missing parameters');
		return;
	}

	if (!this.messageList.contains(message.messageId)) {
		console.log('unexpected message id: ' + message.messageId);
		return;
	}

	var messageHandlers = this.messageList.get(message.messageId);
	messageHandlers.findHandler(this._unserializeNodeArray(message.closestNodes));
};

Node.prototype._sendConnectMessage = function(remoteAddress) {
	var connectMessage = {
		type: protocol.typeCodes['mate_connect'],
		messageId: uuid.v1(),
		nodeId: this.localNodeContact.id.toString()
	};
	this.network.sendMessage(connectMessage, remoteAddress);
	return connectMessage.messageId;
};

Node.prototype._handleConnectMessage = function(message, address) {
	if (!message.nodeId || !message.messageId) {
		console.log('connect message missing parameters');
		return;
	}

	var nodeIdBin = new Buffer(message.nodeId);
	var existNode = this.routeBucket.get(nodeIdBin);
	if (!existNode) {
		this._addNode(nodeIdBin, address);
	}

	var conackMessage = {
		type: protocol.typeCodes['mate_conack'],
		messageId: message.messageId,
		nodeId: this.localNodeContact.id.toString()
	};
	this.network.sendMessage(conackMessage, address);
};

Node.prototype._handleConackMessage = function(message, address) {
	if (!message.nodeId) {
		console.log('conack message missing parameters');
		return;
	}

	if (!this.messageList.contains(message.messageId)) {
		console.log('unexpected message id: ' + message.messageId);
		return;
	}

	var messageHandlers = this.messageList.get(message.messageId);
	messageHandlers.conackHandler(message.nodeId, address);
};

Node.prototype._sendPingMessage = function(remoteAddress) {
	var pingMessage = {
		type: protocol.typeCodes['mate_ping'],
		nodeId: this.localNodeContact.id.toString()
	};
	this.network.sendMessage(pingMessage, remoteAddress);
};

Node.prototype._handlePingMessage = function(message, address) {
	if (!message.nodeId) {
		console.log('ping message missing parameters');
		return;
	}

	var nodeIdBin = new Buffer(message.nodeId);
	var contact = this.routeBucket.get(nodeIdBin);
	if (contact) {
		contact.lastActive = Date.now();
	} else {
		console.log('ping message: unknown node ' + message.nodeId);
	}
};

Node.prototype._indexOfNodeArray = function(nodeIdBin, nodeArray) {
    for (var i = 0; i < nodeArray.length; i++) {
        if (bufferEqual(nodeArray[i].id, nodeIdBin)) {
        	return i;
        }
    }
    return -1;
};

Node.prototype._serializeNodeArray = function(nodeArray) {
	var serializedNodeArray = [];
	for (var i = 0; i < nodeArray.length; i++) {
		serializedNodeArray[i] = {
			id: nodeArray[i].id.toString(),
			address: nodeArray[i].address
		};
	}

	return serializedNodeArray;
};

Node.prototype._unserializeNodeArray = function(serializedNodeArray) {
	var nodeArray = [];
	for (var i = 0; i < serializedNodeArray.length; i++) {
		nodeArray[i] = {
			id: new Buffer(serializedNodeArray[i].id),
			address: serializedNodeArray[i].address
		};
	}

	return nodeArray;
};

Node.prototype._addNode = function(nodeIdBin, nodeAddress) {
	console.log('add node ' + nodeIdBin.toString() + ' ip ' + nodeAddress.ip + ' port ' + nodeAddress.port);

	var that = this;
	var contact = {
		id: nodeIdBin,
		address: nodeAddress,
		lastActive: Date.now(),
		pingInterval: setInterval(function() {
			that._sendPingMessage(contact.address);
		}, this.options.pingInterval * 1000),
		checkInterval: setInterval(function() {
			if (Date.now() - contact.lastActive > 2 * that.options.pingInterval * 1000) {
				console.log('node ' + contact.id.toString() + ' timeout');
				clearInterval(contact.pingInterval);
				clearInterval(contact.checkInterval);
				that.routeBucket.remove(contact);
			}
		}, 2 * this.options.pingInterval * 1000)
	};
	this.routeBucket.add(contact);
};