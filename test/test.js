describe('Node', function(){
	var Node = require('../lib/node')
	  , protocol = require('../lib/protocol')
	  , dgram = require("dgram")
	  , uuid = require('uuid')
	  , bencode = require('bencode');

	var master = null
	  , agent = null;

	beforeEach(function(done) {
		master = new Node({
			networkPort: 2015
		});

		master.on('listening', function() {
			done();
		});
	})

	describe('#connect()', function() {
		it('should return conack', function(done) {
			agent = dgram.createSocket({
				type: "udp4",
				reuseAddr: false
			});

			agent.on('listening', function() {
				var message = {
					type: protocol.typeCodes['mate_connect'],
					messageId: uuid.v1(),
					nodeId: '1234'
				};

				var data = bencode.encode(message);

				agent.send(data, 0, data.length, 2015, '127.0.0.1', function(err, bytes) {
					err && done(err);
				});
			});

			agent.on('message', function(data, remote) {
				try {
					var message = bencode.decode(data, 'utf8');
				} catch (e) {
					done('decode error');
					return;
				}

				if (protocol.types[message.type] !== 'mate_conack') {
					done('error type');
					return;
				}

				done();
			});

			agent.bind(2016);
		})
	})

	afterEach(function(){
		agent && agent.close();
		master.end();
	})
})