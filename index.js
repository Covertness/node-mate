var Node = require('./lib/node');

module.exports.createNode = function(opts) {
	return new Node(opts);
};