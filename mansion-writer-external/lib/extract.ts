import * as cheerio from "cheerio";
import { PropertyFacts, ALIASES, REGEX_CANDIDATES } from "./schema";

export type ExtractResult = {
  facts: PropertyFacts;
  rawTitle?: string;
  rawDescription?: string;
};

export function extractFactsFromHtml(html: string): ExtractResult {
  const $ = cheerio.load(html);
  const facts: PropertyFacts = {};

  // JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).text());
      const list = Array.isArray(json) ? json : [json];
      for (const obj of list) {
        const pick = (k: string) => (typeof obj?.[k] === "string" ? (obj as any)[k] : undefined);
        const name = pick("name");
        const description = pick("description");
        if (name) facts["物件名"] ??= String(name);
        if (description) facts["設備"] ??= String(description);

        const address = obj?.address;
        if (address && typeof address === "object") {
          const adr = [address.postalCode, address.addressRegion, address.addressLocality, address.streetAddress]
            .filter(Boolean).join("");
          if (adr) facts["所在地"] ??= adr;
        }
        if (obj?.floorCount) facts["階数"] ??= String(obj.floorCount);
        if (obj?.numberOfUnits) facts["総戸数"] ??= String(obj.numberOfUnits);
        if (obj?.numberOfRooms) facts["総戸数"] ??= String(obj.numberOfRooms);
        if (pick("yearBuilt")) facts["築年"] ??= String(pick("yearBuilt"));
        if (pick("buildingType")) facts["構造"] ??= String(pick("buildingType"));
      }
    } catch {}
  });

  // Microdata
  $('[itemprop]').each((_, el) => {
    const prop = ($(el).attr("itemprop") || "").trim();
    const val = ($(el).attr("content") || $(el).text() || "").trim();
    if (!prop || !val) return;
    const map: Record<string, keyof PropertyFacts> = {
      name: "物件名",
      address: "所在地",
      addressLocality: "所在地",
      streetAddress: "所在地",
      numberOfRooms: "総戸数",
      numberOfUnits: "総戸数",
      floorCount: "階数",
      description: "設備",
    };
    const key = map[prop];
    if (key && !facts[key]) facts[key] = val;
  });

  // OGP / title / description (not inserted directly)
  const title = $('meta[property="og:title"]').attr("content") || $("title").first().text();
  const desc = $('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content");

  // Table/DL style extraction
  const candidates = new Map<string, string>();
  $("table, dl, .spec, .table, .detail, .property, .summary")
    .find("tr, dt, th")
    .each((_, el) => {
      const label = $(el).text().trim().replace(/\s+/g, "");
      const value = (
        $(el).next("td").text() ||
        $(el).next("dd").text() ||
        $(el).parent().find("td,dd").first().text() ||
        ""
      ).trim().replace(/\s+/g, " ");
      if (!label || !value) return;
      if (label.length > 20 || value.length < 1) return;
      candidates.set(label, value);
    });
  for (const [label, value] of candidates) {
    const stdKey = ALIASES[label];
    if (stdKey && !facts[stdKey]) facts[stdKey] = value;
  }

  // Fallback: regex from body text
  const bodyText = $("body").text().replace(/\s+/g, " ");
  for (const [key, re] of REGEX_CANDIDATES) {
    if (facts[key]) continue;
    const m = bodyText.match(re);
    if (m && m[1]) facts[key] = m[1].trim();
  }

  return { facts, rawTitle: title?.trim(), rawDescription: desc?.trim() };
}

export function factsToLines(facts: PropertyFacts): string {
  return Object.entries(facts)
    .filter(([, v]) => !!v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}
