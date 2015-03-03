var mate = require('../');

var node = mate.createNode({
	networkPort: 2015
});

node.on('message', function(from, message) {
	console.log('receive ' + from.id.toString() + ' message: ' + message);
});

node.on('listening', function() {
	console.log('The mate node ' + node.localNodeContact.id.toString() + ' started');

	node.directConnect({
		ip: '203.195.153.192',
		port: 2015
	}, function(success, newNode) {
		if (success === true) {
			console.log('direct connect node ' + newNode.id.toString() + ' success');

			node.send('98875640-c0d9-11e4-a985-d3d0c6697805', 'I\'m here!', function(success) {
				if (success === true) {
					console.log('send message success');
				} else {
					console.log('send message failed');
				}
			});
		} else {
			console.log('direct connect node failed');
		}
	});

});
