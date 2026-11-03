export function liveServicesEnabled(value = process.env.LIVE_SERVICES_ENABLED): boolean {
  return value === "1";
}
