/*
 * Copyright 2026 Adobe Systems Incorporated
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// DEMO ONLY. An offline stand-in for the Meridian worker's /translate proxy, so
// the GitHub Pages prototype needs no network, no API keys, and no DA session.
// It is a small banking/common-word dictionary applied token-by-token (phrases
// first), good enough to make the compare pane visibly non-English for a UX
// walkthrough. It is NOT a translator and never ships in the real app.

// Full-string translations for the exact copy in the fixture pages — these give
// clean, idiomatic output; the word map below is the fallback for anything else.
const PHRASES = {
  es: {
    'Personal Banking': 'Banca Personal',
    'Business Banking': 'Banca Empresarial',
    'Checking Accounts': 'Cuentas Corrientes',
    'Savings Accounts': 'Cuentas de Ahorro',
    'Home Mortgages': 'Hipotecas',
    'Open an account': 'Abrir una cuenta',
    'Learn more': 'Más información',
    'Apply now': 'Solicitar ahora',
    'Bank with confidence': 'Banca con confianza',
    'Everyday banking made simple': 'La banca diaria, simplificada',
    'Save for what matters': 'Ahorra para lo que importa',
    'Own your home': 'Sé dueño de tu hogar',
    'Welcome to Meridian Bank': 'Bienvenido a Meridian Bank',
  },
  fr: {
    'Personal Banking': 'Banque des Particuliers',
    'Business Banking': 'Banque des Entreprises',
    'Checking Accounts': 'Comptes Courants',
    'Savings Accounts': 'Comptes d’Épargne',
    'Home Mortgages': 'Prêts Immobiliers',
    'Open an account': 'Ouvrir un compte',
    'Learn more': 'En savoir plus',
    'Apply now': 'Faire une demande',
    'Bank with confidence': 'La banque en toute confiance',
    'Everyday banking made simple': 'La banque au quotidien, simplifiée',
    'Save for what matters': 'Épargnez pour l’essentiel',
    'Own your home': 'Devenez propriétaire',
    'Welcome to Meridian Bank': 'Bienvenue chez Meridian Bank',
  },
  de: {
    'Personal Banking': 'Privatkunden',
    'Business Banking': 'Firmenkunden',
    'Checking Accounts': 'Girokonten',
    'Savings Accounts': 'Sparkonten',
    'Home Mortgages': 'Baufinanzierung',
    'Open an account': 'Konto eröffnen',
    'Learn more': 'Mehr erfahren',
    'Apply now': 'Jetzt beantragen',
    'Bank with confidence': 'Bankgeschäfte mit Vertrauen',
    'Everyday banking made simple': 'Alltagsbanking, einfach gemacht',
    'Save for what matters': 'Sparen für das Wesentliche',
    'Own your home': 'Eigenheim besitzen',
    'Welcome to Meridian Bank': 'Willkommen bei der Meridian Bank',
  },
  it: {
    'Personal Banking': 'Banca per Privati',
    'Business Banking': 'Banca per Imprese',
    'Checking Accounts': 'Conti Correnti',
    'Savings Accounts': 'Conti di Risparmio',
    'Home Mortgages': 'Mutui Casa',
    'Open an account': 'Apri un conto',
    'Learn more': 'Scopri di più',
    'Apply now': 'Richiedi ora',
    'Bank with confidence': 'Bancario in tutta sicurezza',
    'Everyday banking made simple': 'La banca di ogni giorno, semplice',
    'Save for what matters': 'Risparmia per ciò che conta',
    'Own your home': 'La tua casa',
    'Welcome to Meridian Bank': 'Benvenuto in Meridian Bank',
  },
  pt: {
    'Personal Banking': 'Banco Pessoal',
    'Business Banking': 'Banco Empresarial',
    'Checking Accounts': 'Contas Correntes',
    'Savings Accounts': 'Contas Poupança',
    'Home Mortgages': 'Crédito Habitação',
    'Open an account': 'Abrir uma conta',
    'Learn more': 'Saber mais',
    'Apply now': 'Candidatar-se',
    'Bank with confidence': 'Banco com confiança',
    'Everyday banking made simple': 'O banco do dia a dia, simplificado',
    'Save for what matters': 'Poupe para o que importa',
    'Own your home': 'Tenha a sua casa',
    'Welcome to Meridian Bank': 'Bem-vindo ao Meridian Bank',
  },
};

// Token-level fallback dictionary for incidental words.
const WORDS = {
  es: {
    the: 'el',
    and: 'y',
    your: 'tu',
    our: 'nuestro',
    for: 'para',
    with: 'con',
    account: 'cuenta',
    accounts: 'cuentas',
    bank: 'banco',
    banking: 'banca',
    personal: 'personal',
    business: 'empresarial',
    checking: 'corriente',
    savings: 'ahorro',
    home: 'hogar',
    mortgage: 'hipoteca',
    mortgages: 'hipotecas',
    loan: 'préstamo',
    loans: 'préstamos',
    card: 'tarjeta',
    cards: 'tarjetas',
    open: 'abrir',
    apply: 'solicitar',
    learn: 'aprender',
    more: 'más',
    welcome: 'bienvenido',
    to: 'a',
    simple: 'simple',
    made: 'hecho',
    everyday: 'diario',
    save: 'ahorrar',
    own: 'poseer',
    money: 'dinero',
    manage: 'gestionar',
    access: 'acceso',
    anywhere: 'en cualquier lugar',
    secure: 'seguro',
    trusted: 'de confianza',
    fast: 'rápido',
    easy: 'fácil',
  },
  fr: {
    the: 'le',
    and: 'et',
    your: 'votre',
    our: 'notre',
    for: 'pour',
    with: 'avec',
    account: 'compte',
    accounts: 'comptes',
    bank: 'banque',
    banking: 'banque',
    personal: 'personnel',
    business: 'entreprise',
    checking: 'courant',
    savings: 'épargne',
    home: 'maison',
    mortgage: 'prêt',
    mortgages: 'prêts',
    loan: 'prêt',
    loans: 'prêts',
    card: 'carte',
    cards: 'cartes',
    open: 'ouvrir',
    apply: 'demander',
    learn: 'apprendre',
    more: 'plus',
    welcome: 'bienvenue',
    to: 'à',
    simple: 'simple',
    made: 'rendu',
    everyday: 'quotidien',
    save: 'épargner',
    own: 'posséder',
    money: 'argent',
    manage: 'gérer',
    access: 'accès',
    anywhere: 'partout',
    secure: 'sécurisé',
    trusted: 'de confiance',
    fast: 'rapide',
    easy: 'facile',
  },
  de: {
    the: 'das',
    and: 'und',
    your: 'Ihr',
    our: 'unser',
    for: 'für',
    with: 'mit',
    account: 'Konto',
    accounts: 'Konten',
    bank: 'Bank',
    banking: 'Banking',
    personal: 'privat',
    business: 'Geschäft',
    checking: 'Giro',
    savings: 'Spar',
    home: 'Zuhause',
    mortgage: 'Hypothek',
    mortgages: 'Hypotheken',
    loan: 'Darlehen',
    loans: 'Darlehen',
    card: 'Karte',
    cards: 'Karten',
    open: 'öffnen',
    apply: 'beantragen',
    learn: 'lernen',
    more: 'mehr',
    welcome: 'willkommen',
    to: 'zu',
    simple: 'einfach',
    made: 'gemacht',
    everyday: 'alltäglich',
    save: 'sparen',
    own: 'besitzen',
    money: 'Geld',
    manage: 'verwalten',
    access: 'Zugriff',
    anywhere: 'überall',
    secure: 'sicher',
    trusted: 'vertrauenswürdig',
    fast: 'schnell',
    easy: 'leicht',
  },
  it: {
    the: 'il',
    and: 'e',
    your: 'tuo',
    our: 'nostro',
    for: 'per',
    with: 'con',
    account: 'conto',
    accounts: 'conti',
    bank: 'banca',
    banking: 'banca',
    personal: 'personale',
    business: 'impresa',
    checking: 'corrente',
    savings: 'risparmio',
    home: 'casa',
    mortgage: 'mutuo',
    mortgages: 'mutui',
    open: 'apri',
    apply: 'richiedi',
    learn: 'scopri',
    more: 'più',
    welcome: 'benvenuto',
    to: 'a',
    simple: 'semplice',
    everyday: 'quotidiano',
    save: 'risparmia',
    money: 'denaro',
    easy: 'facile',
  },
  pt: {
    the: 'o',
    and: 'e',
    your: 'seu',
    our: 'nosso',
    for: 'para',
    with: 'com',
    account: 'conta',
    accounts: 'contas',
    bank: 'banco',
    banking: 'banco',
    personal: 'pessoal',
    business: 'empresarial',
    checking: 'corrente',
    savings: 'poupança',
    home: 'casa',
    mortgage: 'crédito',
    mortgages: 'créditos',
    open: 'abrir',
    apply: 'candidatar',
    learn: 'saber',
    more: 'mais',
    welcome: 'bem-vindo',
    to: 'ao',
    simple: 'simples',
    everyday: 'diário',
    save: 'poupe',
    money: 'dinheiro',
    easy: 'fácil',
  },
};

function matchCase(source, target) {
  if (!source || !target) return target;
  if (source[0] === source[0].toUpperCase()) {
    return target[0].toUpperCase() + target.slice(1);
  }
  return target;
}

function translateWord(word, words) {
  const hit = words[word.toLowerCase()];
  return hit ? matchCase(word, hit) : word;
}

// Translate one source string: exact phrase first, else word-by-word with the
// English word preserved when unknown (so the output reads mostly translated).
function translateOne(source, lang) {
  const phrases = PHRASES[lang] || {};
  if (phrases[source]) return phrases[source];
  const words = WORDS[lang];
  if (!words) return source;
  return source.replace(/[A-Za-zÀ-ɏ]+/g, (w) => translateWord(w, words));
}

// Mirrors the worker's /translate response: an array of target strings aligned
// to the request. `lang` is the language subtag the translator sends (es/fr/...).
export default function fakeTranslate(strings, lang) {
  const base = String(lang || '').toLowerCase().split('-')[0];
  return (strings || []).map((s) => translateOne(s, base));
}
