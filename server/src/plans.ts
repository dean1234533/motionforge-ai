/** What each plan includes. Prices live in Stripe; credits per period are in billing.ts. */
export const PROJECT_LIMITS: Record<string, number> = { free: 3, creator: 25, professional: 200 };
export const projectLimit = (plan: string) => PROJECT_LIMITS[plan] ?? PROJECT_LIMITS.free;

export const PLAN_FEATURES: Record<string, string[]> = {
  free: ['Basic motion tools', 'Up to 3 projects', 'A small monthly AI allowance', 'Standard export with a small MotionForge badge', 'Lower-resolution frames (512 px)'],
  creator: ['More monthly credits', 'Premium AI models', 'Higher-resolution frames (1024 px)', 'Up to 25 projects', 'No badge on exports'],
  professional: ['The largest credit allowance', 'Commercial use', 'Team projects', 'Priority processing', 'Advanced export options', 'Up to 200 projects'],
};
