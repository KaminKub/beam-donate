function determinePrimaryAuth(streamerRow) {
  if (streamerRow.primary_auth_provider) return streamerRow.primary_auth_provider;
  const hasTwitch = !!streamerRow.twitch_id;
  const hasStreamlabs = !!streamerRow.streamlabs_id;
  if (hasTwitch && !hasStreamlabs) return 'twitch';
  if (!hasTwitch && hasStreamlabs) return 'streamlabs';
  if (hasTwitch && hasStreamlabs && streamerRow.twitch_id === streamerRow.streamlabs_id) return 'streamlabs';
  return 'twitch';
}

module.exports = { determinePrimaryAuth };
