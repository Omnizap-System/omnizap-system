import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createWildEncounter, resolveBattleTurn, resolveCaptureAttempt, resolveEvolutionByItem, resolveEvolutionByLevel, resolveSingleAttack } from './rpgBattleService.js';

const PREFERRED_MOVE_NAMES = ['tackle', 'quick-attack', 'scratch', 'pound', 'ember', 'water-gun', 'vine-whip', 'bite', 'gust', 'swift', 'struggle'];

const ensurePokeApiCache = () => {
  if (!(globalThis.__omnizapPokeApiCache instanceof Map)) {
    globalThis.__omnizapPokeApiCache = new Map();
  }
  return globalThis.__omnizapPokeApiCache;
};

const setCache = (cache, key, data) => {
  cache.set(key, {
    data,
    expiresAt: __timeNowMs() + 60 * 60 * 1000,
  });
};

const buildTypeData = ({ pokemonIds = [], doubleDamageTo = [], halfDamageTo = [], noDamageTo = [] } = {}) => ({
  damage_relations: {
    double_damage_to: doubleDamageTo.map((name) => ({ name })),
    half_damage_to: halfDamageTo.map((name) => ({ name })),
    no_damage_to: noDamageTo.map((name) => ({ name })),
  },
  pokemon: pokemonIds.map((id) => ({
    pokemon: {
      name: `poke-${id}`,
      url: `https://pokeapi.co/api/v2/pokemon/${id}/`,
    },
  })),
});

const buildMoveData = (name, type = 'normal', power = 40) => ({
  id: Math.max(1, name.length * 17),
  name,
  power,
  accuracy: 100,
  pp: 35,
  damage_class: { name: power > 0 ? 'physical' : 'status' },
  type: { name: type },
});

const buildPokemonData = ({ id, name, speciesId = id, primaryType = 'normal', moves = PREFERRED_MOVE_NAMES, hp = 45, attack = 49, defense = 49, specialAttack = 65, specialDefense = 65, speed = 45 }) => ({
  id,
  name,
  species: {
    name,
    url: `https://pokeapi.co/api/v2/pokemon-species/${speciesId}/`,
  },
  types: [{ slot: 1, type: { name: primaryType } }],
  stats: [
    { base_stat: hp, stat: { name: 'hp' } },
    { base_stat: attack, stat: { name: 'attack' } },
    { base_stat: defense, stat: { name: 'defense' } },
    { base_stat: specialAttack, stat: { name: 'special-attack' } },
    { base_stat: specialDefense, stat: { name: 'special-defense' } },
    { base_stat: speed, stat: { name: 'speed' } },
  ],
  moves: moves.map((moveName) => ({ move: { name: moveName } })),
  sprites: {
    front_default: `https://img.local/${id}-front.png`,
    front_shiny: `https://img.local/${id}-shiny.png`,
    other: {
      'official-artwork': {
        front_default: `https://img.local/${id}-artwork.png`,
      },
    },
  },
});

const seedCorePokemonData = (cache) => {
  setCache(cache, 'pokemon:1', buildPokemonData({ id: 1, name: 'bulbasaur', primaryType: 'grass', speed: 45 }));
  setCache(cache, 'pokemon:4', buildPokemonData({ id: 4, name: 'charmander', primaryType: 'fire', speed: 65 }));
  setCache(cache, 'pokemon:5', buildPokemonData({ id: 5, name: 'charmeleon', primaryType: 'fire', speciesId: 5, speed: 80 }));
  setCache(cache, 'pokemon:6', buildPokemonData({ id: 6, name: 'charizard', primaryType: 'fire', speciesId: 6, speed: 100 }));
  setCache(cache, 'pokemon:25', buildPokemonData({ id: 25, name: 'pikachu', primaryType: 'electric', speed: 90 }));
  setCache(
    cache,
    'pokemon:26',
    buildPokemonData({
      id: 26,
      name: 'raichu',
      primaryType: 'electric',
      speciesId: 26,
      speed: 110,
    }),
  );

  setCache(cache, 'species:1', {
    id: 1,
    capture_rate: 45,
    evolution_chain: { url: 'https://pokeapi.co/api/v2/evolution-chain/1/' },
  });
  setCache(cache, 'species:4', {
    id: 4,
    capture_rate: 45,
    evolution_chain: { url: 'https://pokeapi.co/api/v2/evolution-chain/2/' },
  });
  setCache(cache, 'species:25', {
    id: 25,
    capture_rate: 190,
    evolution_chain: { url: 'https://pokeapi.co/api/v2/evolution-chain/10/' },
  });
  setCache(cache, 'species:26', {
    id: 26,
    capture_rate: 75,
    evolution_chain: { url: 'https://pokeapi.co/api/v2/evolution-chain/10/' },
  });

  setCache(cache, 'evolution-chain:1', {
    chain: {
      species: { name: 'bulbasaur', url: 'https://pokeapi.co/api/v2/pokemon-species/1/' },
      evolves_to: [
        {
          species: { name: 'ivysaur', url: 'https://pokeapi.co/api/v2/pokemon-species/2/' },
          evolution_details: [{ trigger: { name: 'level-up' }, min_level: 16 }],
          evolves_to: [],
        },
      ],
    },
  });

  setCache(cache, 'evolution-chain:2', {
    chain: {
      species: { name: 'charmander', url: 'https://pokeapi.co/api/v2/pokemon-species/4/' },
      evolves_to: [
        {
          species: { name: 'charmeleon', url: 'https://pokeapi.co/api/v2/pokemon-species/5/' },
          evolution_details: [{ trigger: { name: 'level-up' }, min_level: 16 }],
          evolves_to: [
            {
              species: { name: 'charizard', url: 'https://pokeapi.co/api/v2/pokemon-species/6/' },
              evolution_details: [{ trigger: { name: 'level-up' }, min_level: 36 }],
              evolves_to: [],
            },
          ],
        },
      ],
    },
  });

  setCache(cache, 'evolution-chain:10', {
    chain: {
      species: { name: 'pikachu', url: 'https://pokeapi.co/api/v2/pokemon-species/25/' },
      evolves_to: [
        {
          species: { name: 'raichu', url: 'https://pokeapi.co/api/v2/pokemon-species/26/' },
          evolution_details: [{ trigger: { name: 'use-item' }, item: { name: 'thunder-stone' } }],
          evolves_to: [],
        },
      ],
    },
  });
};

const seedCoreTypeAndMoveData = (cache) => {
  setCache(cache, 'type:grass', buildTypeData({ pokemonIds: [1] }));
  setCache(cache, 'type:electric', buildTypeData({ pokemonIds: [25] }));
  setCache(cache, 'type:normal', buildTypeData());
  setCache(cache, 'type:fire', buildTypeData());
  setCache(cache, 'type:water', buildTypeData());
  setCache(cache, 'type:flying', buildTypeData());
  setCache(cache, 'type:dark', buildTypeData());

  for (const moveName of PREFERRED_MOVE_NAMES) {
    setCache(cache, `move:${moveName}`, buildMoveData(moveName, 'normal', moveName === 'struggle' ? 50 : 40));
  }

  for (let id = 1; id <= 25; id += 1) {
    setCache(cache, `nature:${id}`, {
      id,
      name: `nature-${id}`,
      increased_stat: null,
      decreased_stat: null,
    });
  }
};

const withRandomSequence = async (values, fn) => {
  const originalRandom = Math.random;
  let index = 0;

  Math.random = () => {
    if (!values.length) return 0.5;
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };

  try {
    return await fn();
  } finally {
    Math.random = originalRandom;
  }
};

const buildMoveSnapshot = ({ name = 'tackle', displayName = 'Tackle', power = 40, accuracy = 100, damageClass = 'physical', type = 'normal', effectMeta = {} } = {}) => ({
  name,
  displayName,
  power,
  accuracy,
  damageClass,
  type,
  typeDamage: { doubleTo: [], halfTo: [], noTo: [] },
  effectMeta: {
    target: effectMeta.target || 'selected-pokemon',
    statChanges: Array.isArray(effectMeta.statChanges) ? effectMeta.statChanges : [],
    statChance: Number.isFinite(Number(effectMeta.statChance)) ? Number(effectMeta.statChance) : 100,
    ailment: effectMeta.ailment || null,
    ailmentChance: Number.isFinite(Number(effectMeta.ailmentChance)) ? Number(effectMeta.ailmentChance) : 0,
    healing: Number.isFinite(Number(effectMeta.healing)) ? Number(effectMeta.healing) : 0,
    drain: Number.isFinite(Number(effectMeta.drain)) ? Number(effectMeta.drain) : 0,
  },
});

test('fluxo crítico: explorar -> batalha -> capturar deve ser executável com snapshot válido', { concurrency: false }, async () => {
  const cache = ensurePokeApiCache();
  cache.clear();
  seedCoreTypeAndMoveData(cache);
  seedCorePokemonData(cache);

  const encounter = await withRandomSequence([0.4, 0.8, 0.0, 0.0], async () =>
    createWildEncounter({
      playerLevel: 8,
      preferredTypes: ['grass'],
    }),
  );

  assert.equal(encounter.enemySnapshot.pokeId, 1);
  assert.equal(encounter.enemySnapshot.isShiny, false);

  const battleSnapshot = {
    my: {
      displayName: 'Pikachu',
      level: 12,
      currentHp: 55,
      maxHp: 55,
      types: ['electric'],
      stats: {
        attack: 80,
        defense: 60,
        specialAttack: 80,
        specialDefense: 60,
        speed: 110,
      },
      moves: [
        {
          displayName: 'Tackle',
          name: 'tackle',
          power: 40,
          accuracy: 100,
          damageClass: 'physical',
          type: 'normal',
          typeDamage: { doubleTo: [], halfTo: [], noTo: [] },
        },
        {
          displayName: 'Tackle',
          name: 'tackle',
          power: 40,
          accuracy: 100,
          damageClass: 'physical',
          type: 'normal',
          typeDamage: { doubleTo: [], halfTo: [], noTo: [] },
        },
        {
          displayName: 'Tackle',
          name: 'tackle',
          power: 40,
          accuracy: 100,
          damageClass: 'physical',
          type: 'normal',
          typeDamage: { doubleTo: [], halfTo: [], noTo: [] },
        },
        {
          displayName: 'Tackle',
          name: 'tackle',
          power: 40,
          accuracy: 100,
          damageClass: 'physical',
          type: 'normal',
          typeDamage: { doubleTo: [], halfTo: [], noTo: [] },
        },
      ],
    },
    enemy: encounter.enemySnapshot,
  };

  const turnResult = await withRandomSequence([0.0, 0.0, 0.0, 0.0], async () =>
    resolveBattleTurn({
      battleSnapshot,
      playerMoveSlot: 1,
    }),
  );

  assert.equal(turnResult.validTurn, true);
  assert.ok(turnResult.logs.length > 0);

  turnResult.snapshot.enemy.currentHp = 1;
  turnResult.snapshot.my.currentHp = Math.max(1, turnResult.snapshot.my.currentHp);

  const captureResult = await withRandomSequence([0.0], async () =>
    resolveCaptureAttempt({
      battleSnapshot: turnResult.snapshot,
    }),
  );

  assert.equal(captureResult.validAction, true);
  assert.equal(captureResult.success, true);
  assert.equal(captureResult.winner, 'player');
});

test('deve marcar encontro como shiny e usar sprite shiny quando o roll atender a chance', { concurrency: false }, async () => {
  const cache = ensurePokeApiCache();
  cache.clear();
  seedCoreTypeAndMoveData(cache);
  seedCorePokemonData(cache);

  const encounter = await withRandomSequence([0.4, 0.0, 0.0, 0.0], async () =>
    createWildEncounter({
      playerLevel: 10,
      preferredTypes: ['grass'],
    }),
  );

  assert.equal(encounter.isShiny, true);
  assert.equal(encounter.enemySnapshot.isShiny, true);
  assert.equal(encounter.enemySnapshot.imageUrl, 'https://img.local/1-shiny.png');
});

test('bioma deve priorizar spawn por tipo preferencial', { concurrency: false }, async () => {
  const cache = ensurePokeApiCache();
  cache.clear();
  seedCoreTypeAndMoveData(cache);
  seedCorePokemonData(cache);

  const encounter = await withRandomSequence([0.6, 0.9, 0.0, 0.0], async () =>
    createWildEncounter({
      playerLevel: 10,
      preferredTypes: ['electric'],
    }),
  );

  assert.equal(encounter.enemySnapshot.pokeId, 25);
  assert.ok(encounter.enemySnapshot.types.includes('electric'));
});

test('moveset inicial deve garantir STAB e limitar normal quando houver alternativas', { concurrency: false }, async () => {
  const cache = ensurePokeApiCache();
  cache.clear();
  seedCoreTypeAndMoveData(cache);

  setCache(
    cache,
    'pokemon:1',
    buildPokemonData({
      id: 1,
      name: 'bulbasaur',
      primaryType: 'grass',
      moves: ['tackle', 'scratch', 'vine-whip', 'bite', 'growl', 'struggle'],
    }),
  );
  setCache(cache, 'species:1', {
    id: 1,
    capture_rate: 45,
    evolution_chain: { url: 'https://pokeapi.co/api/v2/evolution-chain/1/' },
  });

  setCache(cache, 'type:grass', buildTypeData({ pokemonIds: [1] }));
  setCache(cache, 'type:normal', buildTypeData({ noDamageTo: ['ghost'] }));
  setCache(cache, 'type:dark', buildTypeData());

  setCache(cache, 'move:tackle', buildMoveData('tackle', 'normal', 40));
  setCache(cache, 'move:scratch', buildMoveData('scratch', 'normal', 40));
  setCache(cache, 'move:vine-whip', buildMoveData('vine-whip', 'grass', 45));
  setCache(cache, 'move:bite', buildMoveData('bite', 'dark', 60));
  setCache(cache, 'move:growl', buildMoveData('growl', 'normal', 0));
  setCache(cache, 'move:struggle', buildMoveData('struggle', 'normal', 50));

  const encounter = await withRandomSequence([0.8, 0.4, 0.2, 0.1], async () =>
    createWildEncounter({
      playerLevel: 10,
      preferredTypes: ['grass'],
    }),
  );

  const offensiveMoves = encounter.enemySnapshot.moves.filter((move) => Number(move?.power) > 0 && move?.damageClass !== 'status');
  const hasStab = offensiveMoves.some((move) => String(move?.type || '').toLowerCase() === 'grass');
  const normalCount = offensiveMoves.filter((move) => String(move?.type || '').toLowerCase() === 'normal').length;

  assert.equal(hasStab, true);
  assert.ok(normalCount <= 1);
});

test('moveset inicial deve evitar softlock por imunidade com fallback neutro', { concurrency: false }, async () => {
  const cache = ensurePokeApiCache();
  cache.clear();
  seedCoreTypeAndMoveData(cache);

  setCache(
    cache,
    'pokemon:66',
    buildPokemonData({
      id: 66,
      name: 'machop',
      primaryType: 'fighting',
      moves: ['karate-chop', 'tackle', 'leer', 'struggle'],
    }),
  );
  setCache(cache, 'species:66', {
    id: 66,
    capture_rate: 180,
    evolution_chain: { url: 'https://pokeapi.co/api/v2/evolution-chain/23/' },
  });

  setCache(cache, 'type:fighting', buildTypeData({ pokemonIds: [66], noDamageTo: ['ghost'] }));
  setCache(cache, 'type:normal', buildTypeData({ noDamageTo: ['ghost'] }));

  setCache(cache, 'move:karate-chop', buildMoveData('karate-chop', 'fighting', 50));
  setCache(cache, 'move:tackle', buildMoveData('tackle', 'normal', 40));
  setCache(cache, 'move:leer', buildMoveData('leer', 'normal', 0));
  setCache(cache, 'move:struggle', buildMoveData('struggle', 'normal', 50));

  const encounter = await withRandomSequence([0.8, 0.4, 0.2, 0.1], async () =>
    createWildEncounter({
      playerLevel: 14,
      preferredTypes: ['fighting'],
    }),
  );

  const offensiveMoves = encounter.enemySnapshot.moves.filter((move) => Number(move?.power) > 0 && move?.damageClass !== 'status');
  const canHitGhost = offensiveMoves.some((move) => !(move?.typeDamage?.noTo || []).includes('ghost'));
  const hasNeutralFallback = encounter.enemySnapshot.moves.some((move) => String(move?.name || '').startsWith('neutral-strike'));

  assert.equal(canHitGhost, true);
  assert.equal(hasNeutralFallback, true);
});

test('evolução automática por nível deve seguir evolution-chain da PokéAPI', { concurrency: false }, async () => {
  const cache = ensurePokeApiCache();
  cache.clear();
  seedCoreTypeAndMoveData(cache);
  seedCorePokemonData(cache);

  const atLevel16 = await resolveEvolutionByLevel({
    pokeId: 4,
    level: 16,
  });
  assert.equal(atLevel16?.from?.pokeId, 4);
  assert.equal(atLevel16?.to?.pokeId, 5);
  assert.equal(atLevel16?.to?.name, 'Charmeleon');

  const atLevel40 = await resolveEvolutionByLevel({
    pokeId: 4,
    level: 40,
  });
  assert.equal(atLevel40?.to?.pokeId, 6);
  assert.equal(atLevel40?.to?.name, 'Charizard');
});

test('evolução por nível deve retornar nulo quando ainda não atingiu requisito', { concurrency: false }, async () => {
  const cache = ensurePokeApiCache();
  cache.clear();
  seedCoreTypeAndMoveData(cache);
  seedCorePokemonData(cache);

  const noEvolution = await resolveEvolutionByLevel({
    pokeId: 1,
    level: 15,
  });
  assert.equal(noEvolution, null);
});

test('evolução por item deve falhar para item inválido', { concurrency: false }, async () => {
  const cache = ensurePokeApiCache();
  cache.clear();
  seedCoreTypeAndMoveData(cache);
  seedCorePokemonData(cache);

  const invalidItem = await resolveEvolutionByItem({
    pokeId: 25,
    itemKey: 'water-stone',
  });
  assert.equal(invalidItem, null);
});

test('evolução por item válida deve resolver próximo estágio', { concurrency: false }, async () => {
  const cache = ensurePokeApiCache();
  cache.clear();
  seedCoreTypeAndMoveData(cache);
  seedCorePokemonData(cache);

  const validItem = await resolveEvolutionByItem({
    pokeId: 25,
    itemKey: 'thunder-stone',
  });
  assert.equal(validItem?.from?.pokeId, 25);
  assert.equal(validItem?.to?.pokeId, 26);
  assert.equal(validItem?.to?.name, 'Raichu');
});

test('ataque único deve aplicar dano e reduzir HP do alvo', () => {
  const attacker = {
    displayName: 'Pikachu',
    level: 15,
    types: ['electric'],
    stats: {
      attack: 70,
      defense: 55,
      specialAttack: 65,
      specialDefense: 55,
      speed: 90,
    },
    moves: [
      {
        displayName: 'Tackle',
        name: 'tackle',
        power: 40,
        accuracy: 100,
        damageClass: 'physical',
        type: 'normal',
        typeDamage: { doubleTo: [], halfTo: [], noTo: [] },
      },
    ],
  };
  const defender = {
    displayName: 'Bulbasaur',
    level: 12,
    currentHp: 80,
    maxHp: 80,
    types: ['grass'],
    stats: {
      attack: 55,
      defense: 60,
      specialAttack: 55,
      specialDefense: 60,
      speed: 50,
    },
    moves: [],
  };

  const result = resolveSingleAttack({
    attackerSnapshot: attacker,
    defenderSnapshot: defender,
    moveSlot: 1,
    attackerLabel: 'Pikachu',
    defenderLabel: 'Bulbasaur',
  });

  assert.equal(result.validMove, true);
  assert.ok(result.damage >= 1);
  assert.ok(result.defender.currentHp < 80);
});

test('paralisia deve poder impedir ação no turno', async () => {
  const caster = {
    displayName: 'Pikachu',
    level: 20,
    currentHp: 95,
    maxHp: 95,
    types: ['electric'],
    stats: {
      attack: 70,
      defense: 55,
      specialAttack: 80,
      specialDefense: 60,
      speed: 95,
    },
    moves: [
      buildMoveSnapshot({
        name: 'thunder-wave',
        displayName: 'Thunder Wave',
        power: 0,
        damageClass: 'status',
        type: 'electric',
        effectMeta: {
          target: 'selected-pokemon',
          ailment: 'paralysis',
          ailmentChance: 100,
        },
      }),
    ],
  };

  const target = {
    displayName: 'Eevee',
    level: 18,
    currentHp: 100,
    maxHp: 100,
    types: ['normal'],
    stats: {
      attack: 65,
      defense: 60,
      specialAttack: 45,
      specialDefense: 65,
      speed: 55,
    },
    moves: [buildMoveSnapshot()],
  };

  const setup = await withRandomSequence([0.0], async () =>
    resolveSingleAttack({
      attackerSnapshot: caster,
      defenderSnapshot: target,
      moveSlot: 1,
      attackerLabel: 'Pikachu',
      defenderLabel: 'Eevee',
    }),
  );

  assert.equal(setup.defender.nonVolatileStatus, 'paralysis');
  assert.ok(setup.logs.some((line) => String(line).includes('paralisado')));

  const blocked = await withRandomSequence([0.0], async () =>
    resolveSingleAttack({
      attackerSnapshot: setup.defender,
      defenderSnapshot: setup.attacker,
      moveSlot: 1,
      attackerLabel: 'Eevee',
      defenderLabel: 'Pikachu',
    }),
  );

  assert.equal(blocked.validMove, true);
  assert.equal(blocked.damage, 0);
  assert.ok(blocked.logs.some((line) => String(line).includes('não conseguiu agir')));
});

test('debuff de ataque deve reduzir dano físico no turno seguinte', async () => {
  const attackerBase = {
    displayName: 'GrowlMon',
    level: 22,
    currentHp: 120,
    maxHp: 120,
    types: ['normal'],
    stats: {
      attack: 70,
      defense: 70,
      specialAttack: 60,
      specialDefense: 65,
      speed: 75,
    },
    moves: [
      buildMoveSnapshot({
        name: 'growl',
        displayName: 'Growl',
        power: 0,
        damageClass: 'status',
        effectMeta: {
          target: 'selected-pokemon',
          statChanges: [{ stat: 'attack', change: -1 }],
          statChance: 100,
        },
      }),
    ],
  };

  const defenderBase = {
    displayName: 'BiteMon',
    level: 22,
    currentHp: 120,
    maxHp: 120,
    types: ['normal'],
    stats: {
      attack: 85,
      defense: 68,
      specialAttack: 50,
      specialDefense: 60,
      speed: 72,
    },
    moves: [buildMoveSnapshot()],
  };

  const baseline = await withRandomSequence([0.0, 0.0], async () =>
    resolveSingleAttack({
      attackerSnapshot: defenderBase,
      defenderSnapshot: attackerBase,
      moveSlot: 1,
      attackerLabel: 'BiteMon',
      defenderLabel: 'GrowlMon',
    }),
  );

  const debuffStep = await withRandomSequence([0.0], async () =>
    resolveSingleAttack({
      attackerSnapshot: attackerBase,
      defenderSnapshot: defenderBase,
      moveSlot: 1,
      attackerLabel: 'GrowlMon',
      defenderLabel: 'BiteMon',
    }),
  );

  assert.ok(debuffStep.logs.some((line) => String(line).includes('reduziu Ataque')));

  const afterDebuff = await withRandomSequence([0.0, 0.0], async () =>
    resolveSingleAttack({
      attackerSnapshot: debuffStep.defender,
      defenderSnapshot: debuffStep.attacker,
      moveSlot: 1,
      attackerLabel: 'BiteMon',
      defenderLabel: 'GrowlMon',
    }),
  );

  assert.ok(afterDebuff.damage < baseline.damage);
});

test('queimadura deve causar dano residual ao final do turno', async () => {
  const caster = {
    displayName: 'Flareon',
    level: 24,
    currentHp: 130,
    maxHp: 130,
    types: ['fire'],
    stats: {
      attack: 95,
      defense: 70,
      specialAttack: 85,
      specialDefense: 80,
      speed: 70,
    },
    moves: [
      buildMoveSnapshot({
        name: 'will-o-wisp',
        displayName: 'Will-O-Wisp',
        power: 0,
        damageClass: 'status',
        type: 'fire',
        effectMeta: {
          target: 'selected-pokemon',
          ailment: 'burn',
          ailmentChance: 100,
        },
      }),
    ],
  };

  const target = {
    displayName: 'Snorlax',
    level: 24,
    currentHp: 160,
    maxHp: 160,
    types: ['normal'],
    stats: {
      attack: 90,
      defense: 75,
      specialAttack: 65,
      specialDefense: 85,
      speed: 30,
    },
    moves: [buildMoveSnapshot()],
  };

  const result = await withRandomSequence([0.0], async () =>
    resolveSingleAttack({
      attackerSnapshot: caster,
      defenderSnapshot: target,
      moveSlot: 1,
      attackerLabel: 'Flareon',
      defenderLabel: 'Snorlax',
    }),
  );

  assert.equal(result.defender.nonVolatileStatus, 'burn');
  assert.ok(result.defender.currentHp < target.maxHp);
  assert.ok(result.logs.some((line) => String(line).includes('dano por queimadura')));
});
