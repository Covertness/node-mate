var mate = require('../');

var node = mate.createNode();

node.on('listening', function() {
	console.log('The mate node started.');
});