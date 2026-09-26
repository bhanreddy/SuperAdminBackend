const { looseSchoolName } = require('./normalization');

const RULE_VERSION = 1;
const LOOSE_JACCARD_MIN = 0.85;
const LOOSE_MIN_TOKENS = 3;
const DISTINCTIVE = /^(east|west|north|south|campus|\d+)$/;

function tokens(value) {
  return String(value || '').split(' ').filter(Boolean);
}

function jaccard(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const token of a) if (b.has(token)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function distinctiveEqual(left, right) {
  const pick = (value) => tokens(value).filter((token) => DISTINCTIVE.test(token)).sort().join('|');
  return pick(left) === pick(right);
}

function looseMatch(leftLoose, rightLoose) {
  if (!leftLoose || !rightLoose) return false;
  if (!distinctiveEqual(leftLoose, rightLoose)) return false;
  const shared = tokens(leftLoose).filter((token) => tokens(rightLoose).includes(token));
  return shared.length >= LOOSE_MIN_TOKENS && jaccard(leftLoose, rightLoose) >= LOOSE_JACCARD_MIN;
}

function sameId(left, right) {
  return left && right && String(left) === String(right);
}

function pushEvidence(list, rule, extra = {}) {
  list.push({ rule, ...extra });
}

function classifyRow(input) {
  const identity = input.identity || {};
  const accounts = [...(input.accounts || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const enquiries = input.enquiries || [];
  const directory = input.directory || [];
  const peers = input.peers || [];
  const coverage = input.coverage || { complete: false };
  const evidence = [];

  if (!identity.valid) {
    return {
      rule_version: RULE_VERSION,
      classification: 'INVALID',
      customer_status: coverage.complete ? 'NO_MATCH' : 'CHECK_INCOMPLETE',
      evidence: [{ rule: 'invalid_identity', code: identity.invalidReason || 'INVALID' }],
      target_account_id: null,
      permitted_actions: ['SKIP'],
      restricted: false,
    };
  }

  const udiseHits = accounts.filter((account) => identity.udise && account.udise && account.udise === identity.udise);
  const nameLocHits = accounts.filter((account) => identity.location_key && account.location_key && identity.strict_name && account.strict_name === identity.strict_name && account.location_key === identity.location_key);
  const channelOf = (account) => new Set([...(account.phones || []), ...(account.emails || [])]);
  const identityChannels = new Set([...(identity.phones || []), ...(identity.emails || [])]);
  const channelHits = accounts.filter((account) => [...channelOf(account)].some((value) => identityChannels.has(value)));
  const looseHits = accounts.filter((account) => identity.location_key && account.location_key === identity.location_key && looseMatch(identity.loose_name || looseSchoolName(identity.strict_name), account.loose_name));

  const peerUdise = peers.filter((peer) => identity.udise && peer.udise === identity.udise && peer.group_id !== identity.group_id);
  const peerChannelDifferentUdise = peers.filter((peer) => peer.udise && identity.udise && peer.udise !== identity.udise && (peer.phones || []).some((value) => identityChannels.has(value)));

  const strongIds = new Set();
  udiseHits.forEach((hit) => strongIds.add(String(hit.id)));
  nameLocHits.forEach((hit) => {
    const corroborated = channelHits.some((hit2) => sameId(hit2.id, hit.id));
    if (corroborated) strongIds.add(String(hit.id));
  });
  if (peerUdise.length) evidence.push({ rule: 'batch_udise_collision' });

  const contradictoryUdise = udiseHits.filter((hit) => {
    const nameClash = identity.strict_name && hit.strict_name && identity.strict_name !== hit.strict_name;
    const locClash = identity.location_key && hit.location_key && identity.location_key !== hit.location_key;
    return nameClash || locClash;
  });

  const visible = (hit) => !hit.restricted;
  const restrictedStrong = [...udiseHits, ...nameLocHits].some((hit) => hit.restricted);
  let classification = 'NEW';
  let target = null;

  if (identity.forced_conflict || peerUdise.length || contradictoryUdise.length || strongIds.size > 1 || (udiseHits.length && nameLocHits.length && !nameLocHits.every((hit) => udiseHits.some((other) => sameId(other.id, hit.id))) && udiseHits.length)) {
    const nameTargets = new Set(nameLocHits.map((hit) => String(hit.id)));
    const udiseTargets = new Set(udiseHits.map((hit) => String(hit.id)));
    const diverged = [...nameTargets].some((id) => udiseTargets.size && !udiseTargets.has(id));
    if (identity.forced_conflict || peerUdise.length || contradictoryUdise.length || strongIds.size > 1 || diverged) {
      classification = 'CONFLICT';
      pushEvidence(evidence, 'conflicting_strong_identifiers');
    }
  }

  if (classification !== 'CONFLICT' && udiseHits.length === 1 && !contradictoryUdise.length) {
    classification = 'EXACT_DUPLICATE';
    target = udiseHits[0];
    pushEvidence(evidence, 'validated_udise', { restricted: Boolean(target.restricted) });
  }

  if (classification !== 'CONFLICT' && classification !== 'EXACT_DUPLICATE') {
    const corroborated = nameLocHits.filter((hit) => channelHits.some((other) => sameId(other.id, hit.id)));
    if (corroborated.length === 1) {
      classification = 'EXACT_DUPLICATE';
      target = corroborated[0];
      pushEvidence(evidence, 'channel_name_location');
    } else if (corroborated.length > 1) {
      classification = 'CONFLICT';
      pushEvidence(evidence, 'multiple_exact_candidates');
    }
  }

  if (classification === 'NEW') {
    if (channelHits.length || nameLocHits.length || looseHits.length || peerChannelDifferentUdise.length) {
      classification = 'POSSIBLE_DUPLICATE';
      if (channelHits.length) pushEvidence(evidence, 'shared_channel_only');
      if (nameLocHits.length) pushEvidence(evidence, 'name_location_only');
      if (looseHits.length) pushEvidence(evidence, 'loose_name_location', { threshold: LOOSE_JACCARD_MIN, min_tokens: LOOSE_MIN_TOKENS });
      if (peerChannelDifferentUdise.length) pushEvidence(evidence, 'shared_channel_different_udise');
      target = [...channelHits, ...nameLocHits, ...looseHits].find(visible) || null;
    }
  }

  const enquiryHits = enquiries.filter((enquiry) => {
    const org = enquiry.organization_strict;
    const channel = (enquiry.phones || []).some((value) => identityChannels.has(value)) || (enquiry.emails || []).some((value) => identityChannels.has(value));
    return (org && org === identity.strict_name) || channel;
  });
  if (enquiryHits.length && classification === 'NEW') {
    classification = 'POSSIBLE_DUPLICATE';
    pushEvidence(evidence, 'unlinked_enquiry_review');
  } else if (enquiryHits.length && classification !== 'CONFLICT') {
    pushEvidence(evidence, 'unlinked_enquiry_review');
  }

  if (!coverage.complete && classification === 'NEW') {
    classification = 'POSSIBLE_DUPLICATE';
    pushEvidence(evidence, 'customer_check_incomplete');
  }

  const directoryExact = directory.filter((row) => {
    if (identity.udise && row.udise && row.udise === identity.udise) return true;
    const channel = (row.phones || []).some((value) => identityChannels.has(value)) || (row.emails || []).some((value) => identityChannels.has(value));
    return channel && row.strict_name === identity.strict_name && row.location_key && row.location_key === identity.location_key;
  });
  const directoryPossible = directory.filter((row) => {
    const channel = (row.phones || []).some((value) => identityChannels.has(value)) || (row.emails || []).some((value) => identityChannels.has(value));
    const name = row.strict_name && row.strict_name === identity.strict_name;
    return channel || name;
  });
  let customerStatus = 'NO_MATCH';
  if (!coverage.complete) customerStatus = directoryExact.length ? 'CONFIRMED_CUSTOMER' : 'CHECK_INCOMPLETE';
  else if (directoryExact.length) customerStatus = 'CONFIRMED_CUSTOMER';
  else if (directoryPossible.length) customerStatus = 'POSSIBLE_CUSTOMER';
  if (directoryExact.length) pushEvidence(evidence, 'customer_directory_exact');
  else if (directoryPossible.length) pushEvidence(evidence, 'customer_directory_possible');

  const restricted = [...udiseHits, ...nameLocHits, ...channelHits, ...looseHits].some((hit) => hit.restricted) || restrictedStrong;
  const permitted = new Set(['SKIP']);
  if (classification === 'INVALID' || classification === 'CONFLICT') {
    permitted.clear();
    permitted.add('SKIP');
  } else if (classification === 'EXACT_DUPLICATE') {
    permitted.add('MERGE');
    permitted.add('UPDATE');
    permitted.add('ADD_CONTACT');
  } else if (classification === 'POSSIBLE_DUPLICATE') {
    permitted.add('ADD_CONTACT');
    permitted.add('IMPORT_NEW');
    if (target) {
      permitted.add('MERGE');
      permitted.add('UPDATE');
    }
  } else if (classification === 'NEW' && coverage.complete && customerStatus !== 'CONFIRMED_CUSTOMER') {
    permitted.add('IMPORT_NEW');
  }
  if (customerStatus === 'CONFIRMED_CUSTOMER') permitted.add('ALREADY_CUSTOMER');
  if (customerStatus === 'CONFIRMED_CUSTOMER' || customerStatus === 'CHECK_INCOMPLETE') permitted.delete('IMPORT_NEW');
  if (restricted && classification !== 'NEW') {
    permitted.delete('MERGE');
    permitted.delete('UPDATE');
    permitted.delete('ADD_CONTACT');
    permitted.delete('IMPORT_NEW');
  }

  const publicEvidence = evidence.map((item) => (restricted && item.rule !== 'customer_check_incomplete' && item.rule !== 'invalid_identity' ? { rule: 'restricted_match', code: 'RESTRICTED_MATCH' } : item));
  const collapsed = [];
  const seen = new Set();
  for (const item of (restricted ? publicEvidence : evidence)) {
    const key = `${item.rule}:${item.code || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    collapsed.push(item);
  }

  return {
    rule_version: RULE_VERSION,
    classification,
    customer_status: customerStatus,
    evidence: collapsed,
    target_account_id: target && !target.restricted ? target.id : null,
    permitted_actions: [...permitted],
    restricted: Boolean(restricted),
  };
}

module.exports = {
  RULE_VERSION,
  LOOSE_JACCARD_MIN,
  LOOSE_MIN_TOKENS,
  jaccard,
  looseMatch,
  classifyRow,
};
