// All six dictionaries, in one place. English is complete by construction; the others may lack keys and fall back to English.
import { de } from "./de.js";
import { en } from "./en.js";
import { es } from "./es.js";
import { fr } from "./fr.js";
import { it } from "./it.js";
import type { Locale } from "./locales.js";
import { ptBR } from "./pt-BR.js";
import type { Dict } from "./translate.js";

export const DICTS: Record<Locale, Dict> = { en, "pt-BR": ptBR as Dict, es: es as Dict, fr: fr as Dict, de: de as Dict, it: it as Dict };
