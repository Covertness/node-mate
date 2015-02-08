title Lookup

participant Node1
participant Node2
participant Node3
participant Node4
participant Node5

note right of Node1: Node5

linear
Node1->Node2: lookup

note left of Node2: Node3

linear off
Node2->Node1: lookresp

note right of Node1: Node5

linear
Node1->Node3: lookup

note left of Node3: Node4

linear off
Node3->Node1: lookresp

note right of Node1: Node5

linear
Node1->Node4: lookup

note left of Node4: Node5

linear off
Node4->Node1: lookresp

note right of Node1: lookup finish