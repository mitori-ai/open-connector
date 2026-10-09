# Existing Airspace quote reads

`airspace.get_quote` uses the authenticated official v3 `GET /orders/quotes/{tracking_id}` endpoint. Supply an existing tracking ID or order number. The action returns estimated cost, estimated delivery time and normalized order details, including flights attached to that quote. Returned identity must match the lookup reference.

This action does not create a quote or book a shipment. Assigned flights are not alternative flight options. Missing cost/currency remain null. `expiresAt` is null because the documented response does not establish quote validity. A caller must obtain validity evidence before presenting the quote as ready to book.

Source: [Airspace v3 documentation](https://api.airspace.com/api-docs/v3), reviewed 9 October 2026. Quote creation uses a separate asynchronous POST and requires account setup/webhook handling; it is outside this action.

Test and production access must be arranged with Airspace. A working tracking URL or order read does not prove that the CF account can retrieve quotes.
