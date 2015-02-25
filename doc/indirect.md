title Indirect connect

participant Node1
participant Node3
participant Node2

linear
Node1->Node3: connect
Node3->Node2: connect

linear off
Node2->Node3: conack
Node3->Node1: conack

linear
Node1<->Node3: ping
Node3<->Node2: ping

Node1<-->Node2: ping periodically

note right of Node1: All packages are included in the server package

note right of Node3: All packages are included in the nat package

note left of Node2: All packages are included in the server package

note left of Node3: All packages are included in the nat package