/**
 * Hoverleser tests: the form-of parser exists twice, in src/background.js and
 * in src/scripts/build-dict.js, because the two do not share a module.
 * These tests fail when the copies disagree, and pin down the parser's rules.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('./harness.js');
const build = require('../src/scripts/build-dict.js');

const background = loadBackground();
const inExtension = (name, ...args) => background.internal(`${name}(...${JSON.stringify(args)})`) ?? null;
const plain = value => JSON.parse(JSON.stringify(value));

// gloss → [kind, base], or null when the gloss is an ordinary definition
const GLOSSES = [
  ['plural of Wort', ['inflection', 'Wort']],
  ['inflection of liegen:', ['inflection', 'liegen']],
  ['plural of Sprache: languages', ['inflection', 'Sprache']],
  ['first/third-person singular preterite of sein: was', ['inflection', 'sein']],
  ['first/third-person singular subjunctive II of hängen', ['inflection', 'hängen']],
  ['strong/mixed nominative/accusative neuter singular of klein', ['inflection', 'klein']],
  ['comparative degree of gut; better', ['inflection', 'gut']],
  ['nominative/accusative/genitive plural of Schwein (“pig”)', ['inflection', 'Schwein']],
  ['alternative form of dass', ['lexical', 'dass']],
  ['obsolete spelling of Tür which was deprecated in 1902', ['lexical', 'Tür']],
  ['agent noun of regeln', ['lexical', 'regeln']],
  ['diminutive of Kasten: a small box', null],
  ['female equivalent of Lehrer (“teacher”)', null],
  ['synonym of Stelle, place something is situated', null],
  ['abbreviation of zum Beispiel', null],
  ['inflection of sich freuen', null],
  ['initialism of the United States of America: a country', null],
  ['cause of death', null],
  ['a municipality of Bavaria', null],
  ['a native or inhabitant of Berlin', null],
  ['of Vietnam; Vietnamese', null],
  ['house', null],
  ['', null],
];

test('parseFormOf classifies glosses', () => {
  for (const [gloss, expected] of GLOSSES) {
    const parsed = build.parseFormOf(gloss);
    assert.deepEqual(parsed && [parsed.kind, parsed.base], expected, gloss);
  }
});

test('a sense tagged form-of is an inflection whatever follows the base', () => {
  const gloss = 'nominative/accusative/genitive plural of Schiff ships';
  assert.equal(build.parseFormOf(gloss), null);
  assert.equal(build.parseFormOf(gloss, true).base, 'Schiff');
  assert.equal(build.parseSenseFormOf({ gl: [gloss], t: ['form-of', 'plural'] }).base, 'Schiff');
});

test('a lexical relation with a sub-gloss is a definition, an inflection with one is not', () => {
  assert.equal(build.parseSenseFormOf({ gl: ['agent noun of regeln', 'regulator'] }), null);
  assert.equal(build.parseSenseFormOf({ gl: ['inflection of liegen:', 'first-person singular present'] }).base, 'liegen');
});

test('background.js and build-dict.js parse glosses identically', () => {
  for (const [gloss] of GLOSSES) {
    for (const tagged of [false, true]) {
      assert.deepEqual(plain(inExtension('parseFormOf', gloss, tagged)), plain(build.parseFormOf(gloss, tagged)), gloss);
    }
  }
  const senses = [
    { gl: ['agent noun of regeln', 'regulator'] },
    { gl: ['inflection of liegen:', 'first-person singular present'], t: ['form-of'] },
    { gl: ['plural of Schiff "ships"'], t: ['form-of'] },
  ];
  for (const sense of senses) {
    assert.deepEqual(plain(inExtension('parseSenseFormOf', sense)), plain(build.parseSenseFormOf(sense)));
  }
});

test('background.js and build-dict.js use the same relation words', () => {
  for (const list of ['INFLECTION_WORDS', 'LEXICAL_WORDS']) {
    assert.deepEqual(plain(background.internal(`[...${list}]`)), [...build[list]], list);
  }
});
