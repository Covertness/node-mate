# node-mate

------

node-mate is a library for the MATE protocol, written in JavaScript for node.js.


## Installation

```sh
npm install node-mate
```

## Example

Starting a mate node is very simple.

```js
var mate = require('node-mate');

var node = mate.createNode({
	networkPort: 2015
});

node.on('listening', function() {
	console.log('mate node ' + node.localNodeContact.id.toString() + ' started');
});
```