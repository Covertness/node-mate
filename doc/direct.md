title Direct connect

participant Node1
participant Node2

linear
Node1->Node2: connect

linear off
Node2->Node1: conack

linear
Node1<->Node2: ping

Node1<-->Node2: ping periodically