var mate = require('../');

var node = mate.createNode({
	networkPort: 2017
});

node.on('listening', function() {
	console.log('The mate node ' + node.localNodeContact.id.toString() + ' started');

	node.directConnect({
		ip: '127.0.0.1',
		port: 2016
	}, function(success) {
		console.log('connect ' + success);
		node.lookup('95499720-b4f6-11e4-afba-efd5b147fc02', function(success, lookupNode, fatherNode) {
			if (success === true) {
				if (fatherNode) {
					console.log('find ' + lookupNode.id.toString() + ' from ' + fatherNode.id.toString());
				} else {
					console.log('find ' + lookupNode.id.toString() + ' locally');
				}
			} else {
				console.log('can\'t find it');
			}
		});
	});

});