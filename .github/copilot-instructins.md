Project: Hotel Guest and Reservation subsystem, microservices, Node + Express + Postgres (pg), React frontend.
Services: gateway, guest, reservation, room-rate, billing, notification. Each has its own DB and folder under /services.
Services talk via REST (see /contracts) and RabbitMQ events (ReservationConfirmed).
Reservation Service runs a saga: hold room -> get-or-create guest -> authorize deposit -> confirm hold -> publish event. On deposit decline, release hold and return 402.
Room holds expire after 10 minutes.
Rules: ES modules, minimal readable code, no comments unless needed, Jest + Supertest for tests, every endpoint gets tests.