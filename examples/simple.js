var mate = require('../');

var node = mate.createNode({
	networkPort: 2017
});

node.on('message', function(from, message) {
	console.log('receive ' + from.id.toString() + ' message: ' + message);
});

node.on('listening', function() {
	console.log('The mate node ' + node.localNodeContact.id.toString() + ' started');

	node.directConnect({
		ip: '127.0.0.1',
		port: 2016
	}, function(success, nodeId) {
		if (success === true) {
			console.log('direct connect node ' + nodeId + ' success');

			node.send('908eea30-bff7-11e4-a566-97d971bca1d1', 'I\'m here!', function(success) {
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