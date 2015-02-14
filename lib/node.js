var KBucket = require('k-bucket')
  , uuid = require('uuid')
  , events = require('events')
  , inherits = require('inherits')
  , ht = require("ht")
  , Network = require('./network')
  , protocol = require('./protocol');

var defaultOptions = {
	networkPort: 2015,
	maxClosestNodes: 2,
	lookupTimeout: 5         // seconds
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
		callback(false);
		return;
	}

	if (this.routeBucket.get(nodeIdBin)) {
		callback(true, this.localNodeContact);
		return;
	}

	var closestNodes = this.routeBucket.closest(nodeIdBin, this.options.maxClosestNodes);
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
		}, this.options.maxClosestNodes * that.options.lookupTimeout * 1000));
	}, that.options.lookupTimeout * 1000);

	var sendLookupMessage = function(node) {
		if (KBucket.distance(node.id, this.routeBucket.localNodeId) === 0) {
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

						callback(true, respNodeArray[index]);
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

Node.prototype.end = function() {
	this.network.close();
};

Node.prototype._setupNetwork = function() {
	var that = this;

	this.network = new Network(this.options);

	this.network.on('listening', this.emit.bind(this, 'listening'));

	this.network.on('net_error', this.emit.bind(this, 'net_error'));
	this.network.on('net_close', this.emit.bind(this, 'net_close'));

	this.network.on('mate_lookup', function (message, remote) {
		that._handleLookupMessage(message, remote);
	});
	this.network.on('mate_lookresp', function (message, remote) {
		that._handleLookrespMessage(message, remote);
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

Node.prototype._handleLookupMessage = function(message, remote) {
	if (!message.lookupNodeId || !message.messageId) {
		console.log('lookup message missing parameters');
		return;
	}

	var lookupNodeIdBin = new Buffer(message.lookupNodeId);
	var closestNodes = this.routeBucket.closest(lookupNodeIdBin, this.options.maxClosestNodes);

	var lookrespMessage = {
		type: protocol.typeCodes['mate_lookresp'],
		messageId: message.messageId,
		closestNodes: closestNodes
	};
	var address = {
		ip: remote.address,
		port: remote.port
	};
	this.network.sendMessage(lookrespMessage, address);
};

Node.prototype._handleLookrespMessage = function(message, remote) {
	if (!message.closestNodes || message.constructor !== Array) {
		console.log('lookresp message missing parameters');
		return;
	}

	if (!this.messageList.contains(message.messageId)) {
		console.log('unexpected message id: ' + message.messageId);
		return;
	}

	var messageHandlers = this.messageList.get(message.messageId);
	messageHandlers.findHandler(message.closestNodes);
};

Node.prototype._indexOfNodeArray = function(nodeIdBin, nodeArray) {
    for (var i = 0; i < nodeArray.length; i++) {
        if (bufferEqual(nodeArray[i].id, nodeIdBin)) {
        	return i;
        }
    }
    return -1;
};