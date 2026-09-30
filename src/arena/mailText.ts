// The sign-in e-mail, in the member's language. Short on purpose: a link, how long it lives, and what to do if it was not asked for.
import type { Locale } from "./locales.js";

const T: Record<Locale, { subject: string; body: (link: string) => string }> = {
  en: { subject: "Your Arena sign-in link", body: (l) => `Open this link to sign in (valid 15 minutes, works once):\n\n${l}\n\nIf you did not ask for it, ignore this e-mail.` },
  "pt-BR": { subject: "Seu link de acesso ao Arena", body: (l) => `Abra este link para entrar (vale por 15 minutos e só funciona uma vez):\n\n${l}\n\nSe você não pediu, ignore este e-mail.` },
  es: { subject: "Tu enlace de acceso a Arena", body: (l) => `Abre este enlace para entrar (válido 15 minutos, funciona una sola vez):\n\n${l}\n\nSi no lo pediste, ignora este correo.` },
  fr: { subject: "Votre lien de connexion à Arena", body: (l) => `Ouvrez ce lien pour vous connecter (valable 15 minutes, utilisable une seule fois) :\n\n${l}\n\nSi vous ne l'avez pas demandé, ignorez cet e-mail.` },
  de: { subject: "Dein Anmeldelink für Arena", body: (l) => `Öffne diesen Link, um dich anzumelden (15 Minuten gültig, nur einmal nutzbar):\n\n${l}\n\nWenn du ihn nicht angefordert hast, ignoriere diese E-Mail.` },
  it: { subject: "Il tuo link di accesso ad Arena", body: (l) => `Apri questo link per accedere (valido 15 minuti, utilizzabile una sola volta):\n\n${l}\n\nSe non l'hai richiesto, ignora questa e-mail.` },
};

export function signInMail(locale: Locale, link: string): { subject: string; text: string } {
  const t = T[locale];
  return { subject: t.subject, text: t.body(link) };
}
