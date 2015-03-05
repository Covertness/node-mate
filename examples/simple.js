var mate = require('../');

var node = mate.createNode({
	networkPort: 2015,
	rootNode: {
		ip: '203.195.153.192',
		port: 2015
	}
});

node.on('message', function(from, message) {
	console.log('receive ' + from.id.toString() + ' message: ' + message);

	node.send(from.id.toString(), 'Hi!', function(success) {
		if (success === true) {
			console.log('send reply message success');
		} else {
			console.log('send reply message failed');
		}
	});
});

node.on('root_connected', function() {
	console.log('root node connected');

/*
	node.send('44e11b60-c1a7-11e4-9771-9180d4138974', 'I\'m here!', function(success) {
		if (success === true) {
			console.log('send message success');
		} else {
			console.log('send message failed');
		}
	});
*/
});

node.on('root_disconnect', function() {
	console.log('root node disconnect');
});