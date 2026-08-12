import type { ProviderDefinition } from "../../core/types.ts";

import { myUnishippersActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "myunishippers",
  displayName: "myUnishippers Tracking",
  description: "Track one shipment through the public myUnishippers tracking service.",
  categories: ["Logistics", "Data"],
  authTypes: ["no_auth"],
  auth: [{ type: "no_auth" }],
  homepageUrl: "https://track.myunishippers.com",
  actions: myUnishippersActions,
};
