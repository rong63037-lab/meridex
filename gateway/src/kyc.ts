export type Access = "allow" | "pending" | "block";

export type CountryRule = {
  country: string;
  access: Access;
  entityId: string | null;
};

export type Policy = {
  byCountry: Record<string, CountryRule>;
};

export type KycDecision = {
  decision: "allow" | "pending" | "deny";
  trading: boolean;
  entityId: string | null;
  reason: string;
  status: "approved" | "pending" | "rejected";
};

function finish(rule: {
  decision: "allow" | "pending" | "deny";
  trading: boolean;
  entityId: string | null;
  reason: string;
}): KycDecision {
  const status = rule.decision === "allow" ? "approved" : rule.decision === "pending" ? "pending" : "rejected";
  return { ...rule, status };
}

/** Sanctions first. Otherwise the residence country's live access row. Nationality is not a block list. */
export function decideKyc(
  input: { nationality: string; residenceCountry: string; sanctionsHit: boolean },
  policy: Policy,
): KycDecision {
  if (input.sanctionsHit) {
    return finish({ decision: "deny", trading: false, entityId: null, reason: "SANCTIONS_HIT" });
  }
  const residence = input.residenceCountry.trim().toUpperCase();
  const rule = policy.byCountry[residence];
  if (!rule) {
    return finish({ decision: "deny", trading: false, entityId: null, reason: "JURISDICTION_CLOSED" });
  }
  if (rule.access === "allow") {
    return finish({
      decision: "allow",
      trading: true,
      entityId: rule.entityId ?? "SG-OPCO",
      reason: `${residence}_ALLOWED`,
    });
  }
  if (rule.access === "pending") {
    return finish({
      decision: "pending",
      trading: false,
      entityId: rule.entityId,
      reason: `${residence}_PENDING`,
    });
  }
  return finish({ decision: "deny", trading: false, entityId: null, reason: "JURISDICTION_BLOCKED" });
}

export function canTrade(status: string | null | undefined): boolean {
  return status === "approved";
}

export function isSourceBlocked(policy: Policy, country: string): boolean {
  return policy.byCountry[country.trim().toUpperCase()]?.access === "block";
}
