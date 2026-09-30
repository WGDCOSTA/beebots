// How a sign-in link reaches a person. The console mailer is for development; Resend's HTTP API is the production one.
export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Prints the message instead of sending it. Development only: the link is a login. It bypasses the log, whose redaction would hide the very token a developer needs. */
export class ConsoleMailer implements Mailer {
  async send(to: string, subject: string, text: string): Promise<void> {
    process.stderr.write(`\n[arena dev mail] to ${to}: ${subject}\n${text}\n\n`);
  }
}

export class ResendMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly from: string, private readonly fetchFn: typeof fetch = fetch) {}
  async send(to: string, subject: string, text: string): Promise<void> {
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`mail provider answered ${res.status}`);
  }
}
