var KBucket = require('k-bucket')
  , uuid = require('uuid')
  , events = require('events')
  , inherits = require('inherits')
  , ht = require("ht")
  , Network = require('./network')
  , protocol = require('./protocol')
  , bufferEqual = require('buffer-equal')
  , bencode = require('bencode')
  , debug = require('debug')('mate-node');

var defaultOptions = {
	networkPort: 2015,
	maxClosestNodes: 2,
	lookupTimeout: 5,         // seconds
	connectTimeout: 5,        // seconds
	messageTimeout: 5,        // seconds
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

Node.prototype.send = function(nodeId, message, callback) {
	var that = this;

	this.lookup(nodeId, function(success, lookupNode, fatherNode) {
		if (success !== true) {
			callback && callback(false);
			return;
		}

		if (fatherNode && fatherNode !== that.localNodeContact) {
			that.indirectConnect(lookupNode.address, fatherNode.address, function(success) {
				if (success !== true) {
					callback && callback(false);
					return;
				}

				that.directConnect(lookupNode.address);
				that.sendWithNode(lookupNode, message, callback);
			});
		} else {
			that.sendWithNode(lookupNode, message, callback);
		}
	});
};

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

	debug('lookup begin: nodeId ' + nodeId);

	var lookupFailTimeout = setTimeout(function() {
		debug('lookup failed: nodeId ' + nodeId);
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
				debug('lookup timeout: messageId ' + messageId + 
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
				callback && callback(true, nodeId);
			} else {
				debug('exist node: ' + nodeId);

				if (existNode.state == protocol.stateCodes['tranship']) {
					clearInterval(existNode.pingInterval);
					existNode.pingInterval = setInterval(function() {
						that._sendPingMessage(existNode.address);
					}, that.options.pingInterval * 1000);
					existNode.lastActive = Date.now();

					debug('node ' + nodeId + ' state changed: tranship -> connected');
					existNode.state = protocol.stateCodes['connected'];
				}

				callback && callback(true, nodeId);
			}
		},
		timeoutHandler: setTimeout(function() {
			debug('directConnect timeout: messageId ' + messageId +
				' address ' + nodeAddress.ip + ':' + nodeAddress.port);
			that.messageList.remove(messageId);
			callback && callback(false);
		}, that.options.connectTimeout * 1000)
	};

	this.messageList.put(messageId, messageHandlers);
};

Node.prototype.indirectConnect = function(connectNodeAddress, transhipNodeAddress, callback) {
	var that = this;

	var messageId = this._sendConnectMessage(connectNodeAddress, transhipNodeAddress);

	var messageHandlers = {
		type: protocol.typeCodes['mate_connect'],
		conackHandler: function(nodeId, remoteAddress, transhipAddress) {
			clearTimeout(messageHandlers.timeoutHandler);
			that.messageList.remove(messageId);

			var nodeIdBin = new Buffer(nodeId);
			var existNode = that.routeBucket.get(nodeIdBin);
			if (!existNode) {
				that._addNode(nodeIdBin, remoteAddress, transhipAddress);
				callback(true);
			} else {
				debug('exist node: ' + nodeId);
				callback(true);
			}
		},
		timeoutHandler: setTimeout(function() {
			debug('indirectConnect timeout: messageId ' + messageId +
				' address ' + connectNodeAddress.ip + ':' + connectNodeAddress.port);
			that.messageList.remove(messageId);
			callback(false);
		}, that.options.connectTimeout * 1000)
	}

	this.messageList.put(messageId, messageHandlers);
};

Node.prototype.sendWithNode = function(node, message, callback) {
	var that = this;

	if (node.state === protocol.stateCodes['connected']) {
		var messageId = this._sendMateMessage(message, node.address);
	} else {
		var messageId = this._sendMateMessage(message, node.address, node.transhipAddress);
	}

	var messageHandlers = {
		type: protocol.typeCodes['mate_message'],
		msgackHandler: function(nodeId, remoteAddress) {
			clearTimeout(messageHandlers.timeoutHandler);
			that.messageList.remove(messageId);

			callback && callback(true);
		},
		timeoutHandler: setTimeout(function() {
			debug('sendMateMessage timeout: messageId ' + messageId +
				' address ' + node.address.ip + ':' + node.address.port);
			that.messageList.remove(messageId);
			callback && callback(false);
		}, that.options.messageTimeout * 1000)
	};

	this.messageList.put(messageId, messageHandlers);
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
	this.network.on('mate_server', function(message, address) {
		that._handleTranshipMessage(message, address);
	});
	this.network.on('mate_nat', function(message, address) {
		that._handleTranship2Message(message, address);
	});
	this.network.on('mate_message', function(message, address) {
		that._handleMateMessage(message, address);
	});
	this.network.on('mate_msgack', function(message, address) {
		that._handleMateAckMessage(message, address);
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
		debug('lookup message missing parameters');
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
		debug('lookresp message missing parameters');
		return;
	}

	if (!this.messageList.contains(message.messageId)) {
		debug('unexpected message id: ' + message.messageId);
		return;
	}

	var messageHandlers = this.messageList.get(message.messageId);
	messageHandlers.findHandler(this._unserializeNodeArray(message.closestNodes));
};

Node.prototype._sendConnectMessage = function(address, transhipAddress) {
	var connectMessage = this._packConnectMessage();

	if (transhipAddress) {
		this._sendTranshipMessage(connectMessage, address, transhipAddress);
	} else {
		this.network.sendMessage(connectMessage, address);
	}
	return connectMessage.messageId;
};

Node.prototype._handleConnectMessage = function(message, address, transhipAddress) {
	var that = this;

	if (!message.nodeId || !message.messageId) {
		debug('connect message missing parameters');
		return;
	}

	var nodeIdBin = new Buffer(message.nodeId);
	var existNode = this.routeBucket.get(nodeIdBin);
	if (!existNode) {
		this._addNode(nodeIdBin, address, transhipAddress);
	} else {
		if (existNode.state == protocol.stateCodes['tranship'] && !transhipAddress) {
			clearInterval(existNode.pingInterval);
			existNode.pingInterval = setInterval(function() {
				that._sendPingMessage(existNode.address);
			}, that.options.pingInterval * 1000);
			existNode.lastActive = Date.now();

			debug('node ' + message.nodeId + ' state changed: tranship -> connected');
			existNode.state = protocol.stateCodes['connected'];
		}
	}

	var conackMessage = {
		type: protocol.typeCodes['mate_conack'],
		messageId: message.messageId,
		nodeId: this.localNodeContact.id.toString()
	};

	if (transhipAddress) {
		this._sendTranshipMessage(conackMessage, address, transhipAddress);
	} else {
		this.network.sendMessage(conackMessage, address);
	}
};

Node.prototype._handleConackMessage = function(message, address, transhipAddress) {
	if (!message.nodeId) {
		debug('conack message missing parameters');
		return;
	}

	if (!this.messageList.contains(message.messageId)) {
		debug('unexpected message id: ' + message.messageId);
		return;
	}

	var messageHandlers = this.messageList.get(message.messageId);
	messageHandlers.conackHandler(message.nodeId, address);
};

Node.prototype._sendPingMessage = function(address, transhipAddress) {
	var pingMessage = {
		type: protocol.typeCodes['mate_ping'],
		nodeId: this.localNodeContact.id.toString()
	};

	if (transhipAddress) {
		this._sendTranshipMessage(pingMessage, address, transhipAddress);
	} else {
		this.network.sendMessage(pingMessage, address);
	}
};

Node.prototype._handlePingMessage = function(message, address, transhipAddress) {
	if (!message.nodeId) {
		debug('ping message missing parameters');
		return;
	}

	var nodeIdBin = new Buffer(message.nodeId);
	var contact = this.routeBucket.get(nodeIdBin);
	if (contact) {
		contact.lastActive = Date.now();
	} else {
		debug('ping message: unknown node ' + message.nodeId);
	}
};

Node.prototype._sendMateMessage = function(message, address, transhipAddress) {
	var mateMessage = {
		type: protocol.typeCodes['mate_message'],
		nodeId: this.localNodeContact.id.toString(),
		messageId: uuid.v1(),
		message: message
	};

	if (transhipAddress) {
		this._sendTranshipMessage(mateMessage, address, transhipAddress);
	} else {
		this.network.sendMessage(mateMessage, address);
	}

	return mateMessage.messageId;
};

Node.prototype._handleMateMessage = function(message, address, transhipAddress) {
	if (!message.nodeId || !message.message || !message.messageId) {
		debug('mate message missing parameters');
		return;
	}

	var nodeIdBin = new Buffer(message.nodeId);
	var contact = this.routeBucket.get(nodeIdBin);
	if (contact) {
		this.emit('message', contact, message.message);

		var msgackMessage = {
			type: protocol.typeCodes['mate_msgack'],
			messageId: message.messageId,
			nodeId: this.localNodeContact.id.toString()
		};

		if (transhipAddress) {
			this._sendTranshipMessage(msgackMessage, address, transhipAddress);
		} else {
			this.network.sendMessage(msgackMessage, address);
		}
	} else {
		debug('mate message: unknown node ' + message.nodeId);
	}
};

Node.prototype._handleMateAckMessage = function(message, address, transhipAddress) {
	if (!message.nodeId) {
		debug('mate ack message missing parameters');
		return;
	}

	if (!this.messageList.contains(message.messageId)) {
		debug('unexpected message id: ' + message.messageId);
		return;
	}

	var messageHandlers = this.messageList.get(message.messageId);
	messageHandlers.msgackHandler(message.nodeId, address);
};

Node.prototype._sendTranshipMessage = function(content, connectNodeAddress, transhipNodeAddress) {
	var transhipMessage = {
		type: protocol.typeCodes['mate_server'],
		connectAddress: connectNodeAddress,
		payload: bencode.encode(content)
	};

	this.network.sendMessage(transhipMessage, transhipNodeAddress);
};

Node.prototype._handleTranshipMessage = function(message, address) {
	if (!message.connectAddress || !message.payload) {
		debug('tranship message missing parameters');
		return;
	}

	var natMessage = {
		type: protocol.typeCodes['mate_nat'],
		sourceAddress: address,
		payload: message.payload
	};
	this.network.sendMessage(natMessage, message.connectAddress);
};

Node.prototype._handleTranship2Message = function(message, address) {
	if (!message.sourceAddress || !message.payload) {
		debug('tranship2 message missing parameters');
		return;
	}

	try {
		var transhipMessage = bencode.decode(message.payload, 'utf8');
	} catch (e) {
		this.emit("data_error", 'decode error');
		debug('tranship2 message is invalid: decode error');
		return;
	}

	if (transhipMessage.type == protocol.typeCodes['mate_connect']) {
		this._handleConnectMessage(transhipMessage, message.sourceAddress, address);
	} else if (transhipMessage.type == protocol.typeCodes['mate_conack']) {
		this._handleConackMessage(transhipMessage, message.sourceAddress, address);
	} else if (transhipMessage.type == protocol.typeCodes['mate_ping']) {
		this._handlePingMessage(transhipMessage, message.sourceAddress, address);
	} else {
		debug('tranship2 message is invalid: unknown type ' + transhipMessage.type);
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

Node.prototype._addNode = function(nodeIdBin, nodeAddress, transhipNodeAddress) {
	var that = this;

	if (transhipNodeAddress) {
		debug('add tranship node ' + nodeIdBin.toString() + 
			' address ' + nodeAddress.ip + ':' + nodeAddress.port + 
			' tranship address ' + transhipNodeAddress.ip + ':' + transhipNodeAddress.port);

		var contact = {
			id: nodeIdBin,
			address: nodeAddress,
			transhipAddress: transhipNodeAddress,
			state: protocol.stateCodes['tranship'],
			lastActive: Date.now(),
			pingInterval: setInterval(function() {
				that._sendPingMessage(contact.address, contact.transhipAddress);
			}, this.options.pingInterval * 1000),
			checkInterval: setInterval(function() {
				if (Date.now() - contact.lastActive > 2 * that.options.pingInterval * 1000) {
					debug('node ' + contact.id.toString() + ' timeout');
					clearInterval(contact.pingInterval);
					clearInterval(contact.checkInterval);
					that.routeBucket.remove(contact);
				}
			}, 2 * this.options.pingInterval * 1000)
		};
		this.routeBucket.add(contact);
	} else {
		debug('add node ' + nodeIdBin.toString() + ' address ' + nodeAddress.ip + ':' + nodeAddress.port);

		var contact = {
			id: nodeIdBin,
			address: nodeAddress,
			state: protocol.stateCodes['connected'],
			lastActive: Date.now(),
			pingInterval: setInterval(function() {
				that._sendPingMessage(contact.address);
			}, this.options.pingInterval * 1000),
			checkInterval: setInterval(function() {
				if (Date.now() - contact.lastActive > 2 * that.options.pingInterval * 1000) {
					debug('node ' + contact.id.toString() + ' timeout');
					clearInterval(contact.pingInterval);
					clearInterval(contact.checkInterval);
					that.routeBucket.remove(contact);
				}
			}, 2 * this.options.pingInterval * 1000)
		};
		this.routeBucket.add(contact);
	}
};

Node.prototype._packConnectMessage = function() {
	return {
		type: protocol.typeCodes['mate_connect'],
		messageId: uuid.v1(),
		nodeId: this.localNodeContact.id.toString()
	};
};

Node.prototype._packPingMessage = function() {
	return {
		type: protocol.typeCodes['mate_ping'],
		nodeId: this.localNodeContact.id.toString()
	};
};