# myUnishippers batch tracking

Use `myunishippers.track_shipments` with `trackingNumbers`, an array of 1 to 25
exact, distinct tracking numbers. The public API needs no credentials. The
runtime joins numbers with commas, then URL-encodes the path (`%2C` separators).

The output `results` follows the input order. Each result includes
`trackingNumber`, a normalized `shipment` or null, and an `error` or null.
A failed shipment does not discard valid results. Both the response identifier
and the shipment tracking number must match the requested number. Missing or
duplicate results return errors. HTTP errors fail the request.

`track_shipment` remains available with its existing single-shipment output.
This endpoint provides tracking data; it does not provide rates or book shipments.
