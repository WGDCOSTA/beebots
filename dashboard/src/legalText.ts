// The four legal pages, in English. English is the text that counts; other languages show a notice and this same text.
// DRAFT: written from what the Arena actually does today (the test in test/arena-legal.test.ts checks the facts that can be
// checked: retention periods, cookie and storage names, prices, the minimum age, the processors). It has NOT been reviewed by a
// lawyer. The operator is in Ireland: counsel must review it (GDPR, the Irish Data Protection Commission, EU consumer law,
// e-commerce rules, VAT, and whether the product is a regulated service) before it is called final. See docs/ARENA_LEGAL_OUTLINE.md.
// {{operator.x}} is replaced with the operator's details (ARENA_OPERATOR_* settings); a detail not set shows as missing.
export type LegalDocId = "terms" | "privacy" | "risk" | "cookies";

export interface LegalSection {
  h: string;
  p?: string[];
  li?: string[];
}
export interface LegalDocText {
  updated: string;
  intro: string;
  sections: LegalSection[];
}

export const LEGAL_UPDATED = "2026-10-02";

const CONTACT = "Questions about this text: {{operator.email}}.";

export const LEGAL: Record<LegalDocId, LegalDocText> = {
  terms: {
    updated: LEGAL_UPDATED,
    intro: "These terms are the agreement between you and {{operator.name}} ({{operator.address}}, company number {{operator.companyNo}}, VAT {{operator.vat}}), who runs the Arena (\"we\", \"us\"). Please read them with the Risk notice and the Privacy notice.",
    sections: [
      {
        h: "What the Arena is",
        p: [
          "The Arena lets you build trading agents and run them on simulated money against real market prices, and compares them on a public leaderboard.",
          "The Arena is software only. It is not a broker, an exchange, a bank or an investment firm. We do not hold your money, we do not trade for you, we do not give investment advice or recommendations, and nothing in the Arena is an offer to buy or sell anything. Every account in the Arena is a simulation. Real orders are never sent to any exchange by the Arena.",
        ],
      },
      {
        h: "Your account",
        li: [
          "You sign in with a one-time link sent to your e-mail address. There is no password. Keep your mailbox safe: anyone who can read it can sign in as you.",
          "You must be 18 or older. By creating an account you confirm that you are.",
          "One account per person. Give us true information, and keep your public name decent: it is shown to others.",
          "You may delete your account at any time from the Me page. Deleting it removes your data as described in the Privacy notice.",
        ],
      },
      {
        h: "What is available, and what is not yet",
        p: [
          "The Arena runs your agents on paper (simulated money) with decisions made by AI models. Some features shown on the plans page are marked \"coming soon\". They are not available yet and we do not promise a date. A feature marked \"coming soon\" is not part of what you pay for until it is available.",
          "Connecting a real exchange account is not offered in the Arena. If we ever offer it, it will come with its own terms and risk warnings, and you would act on your own account and at your own risk.",
          "We do our best to keep the Arena running, but it is provided \"as is\" and may be unavailable, slow, wrong or changed. Market data comes from public sources and can be late or missing. We may change or stop features, with reasonable notice where we can.",
        ],
      },
      {
        h: "Plans and payment",
        li: [
          "Free costs nothing. Pro costs €9.99 per month and Premium costs €15.99 per month. Taxes (such as VAT) are shown before you pay, on Stripe's payment page.",
          "Paid plans renew every month until you cancel. You can change plan or cancel at any time from \"Manage billing\" (Stripe's page). A cancellation takes effect at the end of the period you have paid for. We do not refund part of a period, except where the law says we must.",
          "Payment is handled by Stripe. We never see or store your card details.",
          "If you are a consumer in the EU, you have a right to withdraw from a distance contract within 14 days. For a digital service you ask us to start straight away, you agree that if you use it during this time you pay for the days used, and the right ends once the service has been fully provided, as the law allows. [Counsel to confirm this wording and how it is presented at checkout.]",
          "If a payment fails or you cancel, your plan returns to Free at the end of the paid period. Agents, skills or model choices that the Free plan does not include are not deleted at once: the agents are stopped, taken off the leaderboard and kept in quarantine for 10 days. Upgrading again within that time restores them, stopped, and nothing starts trading until you press Start again. After 10 days quarantined agents are deleted. Skills over your slots are kept locked, not deleted, until your plan allows them again.",
          "We may change prices or plans. A price change applies from your next renewal and we tell you before it does.",
        ],
      },
      {
        h: "Your agents, skills and content",
        p: [
          "The agents, rules, names, skills and other content you create are yours. You give us the right to store them, run them and show the parts you choose to show (see the leaderboard section) for as long as it takes to provide the Arena.",
          "Do not use names, rules or other content that is unlawful, abusive, hateful, sexual, misleading about who you are, or that infringes someone else's rights. We may rename or remove such content and, if it is serious or repeated, close the account.",
          "Portraits are painted by an AI image model from the words you give. We do not guarantee that they are original or free of resemblance to existing works.",
          "A skill you write is data in the platform's rule language. The skills in our library are examples and starting points. None of them has been tested on history here, and none is a promise of any result.",
        ],
      },
      {
        h: "Your own model keys",
        p: [
          "If you add your own API key for an AI provider, you are responsible for your agreement with that provider and for what it costs you. We keep the key encrypted and use it only to run your agents. The daily ceiling you may set is an estimate made from the number of tokens, and a provider may charge more than it says. You can delete the key here at any time and revoke it with the provider.",
          "An agent that is set to use your key stops (it does not switch to our model) if the key is removed or stops working.",
        ],
      },
      {
        h: "The leaderboard and fair play",
        p: [
          "The leaderboard ranks agents by simulated results. If you keep an agent listed, others can see its name, style, results and your public name. They never see your e-mail, rules or open positions. You can unlist an agent at any time.",
          "Do not try to cheat: no several accounts to push one agent up, no use of faults in the Arena or its data to get results that a real market would not give, no interference with other members. We may remove agents or results, and close accounts, that do. There are no prizes at present. If we ever offer any, they will have their own rules.",
        ],
      },
      {
        h: "What you may not do",
        li: [
          "Use the Arena to break the law, or to mislead others about real trading results or to present simulated results as real performance or as investment advice.",
          "Try to reach other members' data, or to disturb, overload or reverse-engineer the Arena.",
          "Collect other members' public information in bulk, or resell access to the Arena.",
          "Share your sign-in link or let someone else use your account.",
        ],
      },
      {
        h: "Other companies' services",
        p: ["The Arena relies on other services: for payment (Stripe), for e-mail, for hosting, for AI models (including OpenAI and, if you add your own keys, the providers you choose) and for public market data. We are not responsible for their faults or terms. Their own terms apply to what you do with them directly."],
      },
      {
        h: "Our rights in the Arena",
        p: ["The Arena, its software, design, texts and brand belong to us or our licensors. You may use the Arena as these terms allow, and nothing more. Feedback you give us may be used without payment."],
      },
      {
        h: "Responsibility",
        p: [
          "Nothing in these terms limits or excludes liability that cannot be limited or excluded by law, including for death or personal injury caused by negligence, for fraud, and for the rights a consumer has under mandatory law.",
          "Subject to that, the Arena is provided as is. We are not responsible for losses that come from decisions you make, with real money, on the basis of results, rankings, agents' choices or anything else in the Arena, which is simulated. Our total liability to you for a claim about the Arena is limited to what you paid us in the 12 months before the claim, except where the law does not allow such a limit. [Counsel to confirm.]",
        ],
      },
      {
        h: "Ending the agreement",
        p: ["You can stop using the Arena and delete your account at any time. We may suspend or close an account that breaks these terms, or if the law requires, and where we can we tell you why and give you a chance to put it right. If we close the Arena, we give you notice and, for a paid plan, refund the part of the period you paid for and did not get."],
      },
      {
        h: "Changes to these terms",
        p: ["We may change these terms. If the change matters, you are asked to accept the new version before you carry on (we record which version you accepted and when). If you do not accept, you can delete your account."],
      },
      {
        h: "Law and disputes",
        p: ["Irish law governs these terms and the courts of Ireland have jurisdiction, but if you are a consumer you keep the protection of the mandatory rules of the country where you live and may also go to the courts there. [Counsel to confirm.] Please contact us first: " + CONTACT],
      },
    ],
  },

  privacy: {
    updated: LEGAL_UPDATED,
    intro: "This notice explains what personal data the Arena uses, why, who sees it, how long we keep it and what rights you have. The controller is {{operator.name}}, {{operator.address}}. For anything about your data write to {{operator.privacyEmail}}.",
    sections: [
      {
        h: "What we collect",
        li: [
          "Your e-mail address, to sign you in, to write to you about your account and to take payment.",
          "Your public name (we give you a neutral one; you can change it), your language, the plan you are on, the date you joined.",
          "What you accepted and when: the version of the Terms and the three confirmations (terms, simulated money, 18 or older). We keep the version and the time, nothing else.",
          "What you create: your agents (names, looks, rules, coins, styles, versions, state), their paper accounts, decisions and trades, portraits, your skills, and your model keys (encrypted).",
          "If you pay: Stripe tells us your Stripe customer and subscription identifiers, the state of the subscription and the end of the current period. Your card details stay with Stripe.",
          "A security log of account events (for example signing in, accepting the terms, changing plan, deleting the account), linked to a random account identifier.",
          "What you ask your agents in their chat, and their answers (with the charts' market data). Questions anyone asks one of our own house agents are not stored: the visitor's page keeps that conversation, and we hold the network address in memory for one hour only to limit how many questions are asked.",
          "Your network address and e-mail address when you ask for a sign-in link, only to limit abuse (see how long below).",
          "A cookie that keeps you signed in, and two small preferences in your browser (see the Cookies page). We do not use analytics or advertising cookies or trackers.",
        ],
      },
      {
        h: "Why we use it, and on what basis",
        li: [
          "To provide the Arena and your account, and to take payment: performance of our contract with you.",
          "To keep the Arena safe, limit abuse, prevent fraud and fix faults: our legitimate interest in running a secure service.",
          "To keep records that the law requires, for example for tax and accounting: legal obligation.",
          "To show agents you choose to list on the public leaderboard: performance of the contract, based on your choice, which you can undo by unlisting.",
          "We do not sell your data, and we do not use it for advertising.",
        ],
      },
      {
        h: "Who receives it",
        p: ["We use other companies to run the Arena (processors). They may use the data only on our instructions. At present:"],
        li: [
          "Stripe, for payments and invoices (Stripe also acts as an independent controller for its own legal duties).",
          "An e-mail provider (Resend), which receives your address and the text of the sign-in message.",
          "Our hosting provider [name and country to be filled in], where the Arena and its databases run.",
          "OpenAI, which receives what you type into the free AI design of your first agent (a sentence about it), the name and look text used to paint a portrait, and, when an agent runs on our model, the agent's rules and market data to decide each move. We do not send your e-mail address or public name.",
          "The same AI provider that answers for an agent (ours, or the one behind the agent's own key) receives a chat question with the last few messages, the agent's rules, its own record and market data, to write the answer.",
          "The AI provider behind each model key you add yourself (OpenAI, Anthropic, Z.ai or Moonshot): when an agent runs on your key it receives the same agent rules and market data. Your agreement with that provider applies.",
          "Public market data comes from an exchange's public interface and contains no personal data.",
          "Others see only what you choose to list on the leaderboard: your public name, an agent's name, style, version and results. Never your e-mail address, rules or positions.",
          "Authorities, where the law requires it.",
        ],
      },
      {
        h: "Where it goes",
        p: ["Some of these companies are based in, or process data in, countries outside the European Economic Area (for example the United States). Where that happens we rely on a transfer mechanism the law accepts, such as the EU-US Data Privacy Framework or standard contractual clauses. [Counsel to confirm the mechanism for each provider.]"],
      },
      {
        h: "How long we keep it",
        li: [
          "Sign-in links: valid for 15 minutes and usable once. The record of a link (which holds the address it was sent to) is deleted one day after it expires.",
          "Your signed-in session: 30 days from your last visit; it ends at once when you sign out.",
          "Records of sign-in requests used to limit abuse (address and e-mail): 1 hour.",
          "The security log: 365 days.",
          "Chat with your agents: the last 60 messages of each agent, until you clear the conversation or delete the agent or your account. Visitors' questions to house agents: not stored; their network address is kept in memory for one hour.",
          "Your account, agents, paper accounts, portraits, skills, model keys, plan record and acceptance record: until you delete your account. Deleting it removes them right away, including your agents' places on the leaderboard.",
          "Payment records: Stripe and we keep invoices and payment records for as long as tax and accounting law require. [Counsel to confirm the period.]",
          "Backups: [to be filled in by the operator: how often, and how long a backup is kept]. Data you deleted can remain in a backup until it expires.",
        ],
      },
      {
        h: "Your rights",
        p: [
          "You have the right to be told what we hold about you and to get a copy, to have wrong data corrected, to have your data deleted, to restrict or object to some uses, to receive the data you gave us in a usable format, and to withdraw a consent you gave. You can delete your account yourself on the Me page and change your public name there. There is not yet a button to download your data: ask by e-mail and we will send it. Write to {{operator.privacyEmail}}; we answer within one month.",
          "You may complain to the Data Protection Commission of Ireland (dataprotection.ie), or to the supervisory authority where you live.",
        ],
      },
      {
        h: "Security",
        p: ["Sign-in tokens and sessions are stored only as hashes. Every member's data is kept in a database of their own. Model keys are encrypted and are only decrypted to run your agents. No system is perfectly safe. If something goes wrong with your data we will tell you and the authorities as the law requires."],
      },
      {
        h: "Decisions made by software",
        p: ["Agents make simulated trading decisions with AI models. They have no legal or similarly significant effect on you. We do not take decisions about you with legal effect by automated means."],
      },
      {
        h: "Children",
        p: ["The Arena is for adults only (18 or older). We do not knowingly collect data from anyone younger. If you think a child has an account, tell us and we will delete it."],
      },
      {
        h: "Changes",
        p: ["If we change this notice in a way that matters, we say so in the Arena. " + CONTACT],
      },
    ],
  },

  risk: {
    updated: LEGAL_UPDATED,
    intro: "Please read this before you rely on anything you see in the Arena. {{operator.name}} runs the Arena. It is not a broker or an adviser, and nothing here is investment advice.",
    sections: [
      {
        h: "It is a simulation",
        p: [
          "Every agent in the Arena trades with simulated money. No order is ever sent to a real exchange. Prices are real, but fills, fees and funding are modelled, and a real market would give different results.",
          "Simulated results have limits that real results do not. In a simulation there is no real order book to move, orders are filled at modelled prices, there are no outages, rejected orders, partial fills or changes in an exchange's rules, and nobody's money is at risk. Results that look good in a simulation can be very different, or negative, with real money.",
        ],
      },
      {
        h: "Past results do not predict future results",
        p: ["A high place on the leaderboard, a good week, a long run of profits or a good result of a skill does not mean that an agent, a skill or a strategy will make money in the future. Rankings change from week to week and a short season can be won by luck or by taking a risk that happens to pay."],
      },
      {
        h: "AI models can be wrong",
        p: [
          "Agents decide with AI models. A model can misread the situation, be confidently wrong, fail to answer or give different answers to the same question. A model's one-line reason is what the model said, not a checked explanation.",
          "Using several models at once, or letting an agent choose its own style, does not make a result safer. It adds cost and complexity and can make results worse.",
          "An agent that cannot get an answer holds. The risk rules (stops, limits) are code, but they too can fail to protect you in a simulation, and would be able to protect less in a real market.",
        ],
      },
      {
        h: "Markets are risky",
        p: ["Crypto-asset prices can move very fast and by large amounts, can gap, and can fall to zero. The agents can take long and short positions, which can lose more than a simple purchase. Leverage multiplies both gains and losses. If you ever trade for real, you can lose all the money you put in, or more."],
      },
      {
        h: "Do not use the Arena as advice",
        p: ["Nothing in the Arena, including an agent's decision, a ranking, a skill, a template or a model's reason, is a recommendation to buy, sell or hold anything. Decide for yourself, and take professional advice if you need it. Do not present simulated results to others as real performance or as advice."],
      },
      {
        h: "Costs of your own model keys",
        p: ["An agent that runs on your own AI key costs you what the provider charges for every call, and several models together cost the sum. The ceiling you set is an estimate and can be exceeded. Check your provider's usage."],
      },
      {
        h: "Real trading",
        p: ["The Arena does not trade real money and does not offer a connection to a real exchange account. We do not hold your funds. If you trade real money elsewhere, with a rule you built here or any other, you do so on your own account, on your own decision and at your own risk."],
      },
      {
        h: "Other risks",
        p: ["The Arena can be unavailable or wrong. Data can be late or missing. A plan or feature can change. Read the Terms. " + CONTACT],
      },
    ],
  },

  cookies: {
    updated: LEGAL_UPDATED,
    intro: "The Arena uses one cookie to keep you signed in and stores two small preferences in your browser. It uses no analytics, no advertising and no tracking.",
    sections: [
      {
        h: "The cookie we set",
        li: [
          "arena_session: keeps you signed in. It is needed for the Arena to work when you are signed in, so it does not need your consent. It is only sent to the Arena (HttpOnly, SameSite=Lax, and Secure when the site uses https). It lasts 30 days from your last visit and is removed when you sign out.",
        ],
      },
      {
        h: "What we store in your browser",
        li: [
          "arena_locale: the language you chose. It stays in your browser until you clear it.",
          "arena_checklist_hidden: remembers that you hid the \"Getting started\" list. It stays in your browser until you clear it.",
          "These are preferences you ask for. They are kept in your browser and are not used to follow you.",
        ],
      },
      {
        h: "Other companies' cookies",
        p: ["When you pay, you leave the Arena for Stripe's page. Stripe sets its own cookies there, under its own notice. The Arena itself sets no other cookie."],
      },
      {
        h: "Your choices",
        p: ["You can delete or block cookies and stored data in your browser settings. If you block the sign-in cookie you cannot stay signed in. Signing out removes it. " + CONTACT],
      },
    ],
  },
};

/** The placeholders the texts use, with where each is filled from. */
export const OPERATOR_FIELDS = ["name", "address", "companyNo", "vat", "email", "privacyEmail"] as const;
export type OperatorField = (typeof OPERATOR_FIELDS)[number];

/** Fills {{operator.x}}. A detail that is not set is shown as [x missing], so a gap is never hidden. Returns the pieces so the page can mark gaps. */
export function fillOperator(text: string, op: Partial<Record<OperatorField, string>>): Array<{ text: string; missing: boolean }> {
  const out: Array<{ text: string; missing: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(/\{\{operator\.(\w+)\}\}/g)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), missing: false });
    const v = (op as Record<string, string | undefined>)[m[1]!]?.trim();
    out.push(v ? { text: v, missing: false } : { text: `[${m[1]} missing]`, missing: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), missing: false });
  return out;
}
