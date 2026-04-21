/**
 * Integrations - compose-on seam for external orchestrators.
 *
 * See ./README.md for the architectural intent.
 *
 * No integrations ship today. Each integration (langgraph/,
 * temporal/, nextjs/) will land as its own follow-up PR and get
 * its own subpath export (layered-autonomous-governance/integrations/langgraph).
 *
 * This file intentionally exports nothing - a top-level `export {}`
 * is enough to mark this as a module without leaking a namespace.
 */
export {};
