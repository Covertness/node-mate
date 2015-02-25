/* Protocol - protocol constants */

/* Message type code => mnemonic */
module.exports.types = {
	0: 'mate_lookup',
	1: 'mate_lookresp',
	2: 'mate_server',
	3: 'mate_nat',
	4: 'mate_connect',
	5: 'mate_conack',
	6: 'mate_ping'
};

/* Mnemonic => Message type code */
module.exports.typeCodes = {}
for(var k in module.exports.types) {
	var v = module.exports.types[k];
	module.exports.typeCodes[v] = k;
}

/* Connection state code => mnemonic */
module.exports.states = {
	1: 'connecting',
	2: 'tranship',
	3: 'connected'
}

/* Mnemonic => Connection state code */
module.exports.stateCodes = {}
for(var k in module.exports.states) {
	var v = module.exports.states[k];
	module.exports.stateCodes[v] = k;
}