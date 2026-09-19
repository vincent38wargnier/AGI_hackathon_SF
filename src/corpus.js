export const corpus = [
  {
    id: "kb-pricing-feedback-q3",
    source: "knowledge",
    title: "Synthetic AcmeFlow Q3 Pricing Feedback",
    content:
      "Synthetic corpus. Forty-two trial users mentioned that the annual plan discount is visible too late in checkout. Sixteen described the monthly plan as easier to understand, but eleven said the annual price felt more credible once savings were shown before the payment step.",
  },
  {
    id: "kb-retention-interviews",
    source: "knowledge",
    title: "Synthetic Retention Interview Notes",
    content:
      "Synthetic corpus. Churned accounts most often cited onboarding confusion and missing team templates. Pricing was mentioned as a secondary reason when the account had fewer than three active projects after week one.",
  },
  {
    id: "kb-enterprise-objections",
    source: "knowledge",
    title: "Synthetic Enterprise Sales Objections",
    content:
      "Synthetic corpus. Enterprise prospects asked for SSO, audit logs, and clearer admin controls before discussing price. Procurement teams accepted annual commitments when security review was complete.",
  },
  {
    id: "mem-founder-goals",
    source: "memory",
    title: "Synthetic Founder Memory",
    content:
      "Synthetic memory. The founder is trying to improve paid conversion without increasing support load. They prefer concise recommendations with risks and next experiments.",
  },
  {
    id: "mem-last-experiment",
    source: "memory",
    title: "Synthetic Last Experiment",
    content:
      "Synthetic memory. Last month the team moved testimonials above pricing. Trial-to-paid conversion rose slightly, but cancellation in the first 14 days did not improve.",
  },
];

const STOP = new Set("the a an and or to of in for on with i we you our should what how is are do does did this that it my".split(" "));

export function searchCorpus(query, source) {
  const q = query.toLowerCase();
  const terms = q.split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t));
  return corpus
    .filter((doc) => !source || doc.source === source)
    .map((doc) => {
      const hay = `${doc.title} ${doc.content}`.toLowerCase();
      const score = terms.reduce((n, term) => n + (hay.includes(term) ? 1 : 0), 0);
      return { ...doc, score };
    })
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
