export const SPOTIFY_TEST_PAGE = String.raw`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Resonance Spotify Test</title>

<style>
  body {
    font: 16px system-ui;
    max-width: 800px;
    margin: 40px auto;
    padding: 0 20px;
    background: #15151b;
    color: #eee;
  }
  input, select, button {
    font: inherit;
    padding: 10px;
    margin: 5px 0;
  }
  input { display: block; width: 95%; }
  button { cursor: pointer; }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: #23232c;
    padding: 16px;
  }
</style>

<h1>Resonance Spotify Test</h1>

<label>Email
  <input id="email" type="email" autocomplete="email">
</label>

<label>Resonance password
  <input id="password" type="password" autocomplete="current-password">
</label>

<button id="login">Log in</button>
<button id="connect">Connect Spotify</button>
<button id="status">Connection status</button>

<p>
  <select id="range">
    <option value="short_term">About 4 weeks</option>
    <option value="medium_term" selected>About 6 months</option>
    <option value="long_term">About 1 year</option>
  </select>
</p>

<button id="sync">Sync</button>
<button id="saved">Read saved profile</button>
<button id="disconnect">Disconnect and delete saved Spotify data</button>

<pre id="output" aria-live="polite">Log in with an existing Resonance account.</pre>

<script>
(() => {
  let token = '';
  const el = id => document.getElementById(id);
  const show = value => {
    el('output').textContent =
      typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2);
  };

  async function api(path, method = 'GET', body, authenticated = true) {
    if (authenticated && !token) {
      throw new Error('Log in to Resonance first.');
    }

    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(authenticated
          ? { Authorization: 'Bearer ' + token }
          : {}),
      },
      ...(body !== undefined
        ? { body: JSON.stringify(body) }
        : {}),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    return data;
  }

  function action(id, handler) {
    el(id).onclick = async () => {
      el(id).disabled = true;
      try {
        await handler();
      } catch (error) {
        show(error.message);
      } finally {
        el(id).disabled = false;
      }
    };
  }

  action('login', async () => {
    token = '';
    try {
      const data = await api('/auth/login', 'POST', {
        email: el('email').value,
        password: el('password').value,
      }, false);
      token = data.accessToken;
      show({ message: 'Logged in', user: data.user });
    } finally {
      el('password').value = '';
    }
  });

  action('connect', async () => {
    if (!token) throw new Error('Log in first.');

    const popup = window.open('about:blank', '_blank');
    if (!popup) throw new Error('Allow popups and try again.');
    popup.opener = null;

    try {
      const data = await api('/spotify/connect', 'POST');
      popup.location.href = data.authorizationUrl;
      show('Authorize Spotify in the new tab, then return here and click Sync.');
    } catch (error) {
      popup.close();
      throw error;
    }
  });

  action('status', async () => {
    show(await api('/spotify/status'));
  });

  action('sync', async () => {
    show(await api('/spotify/sync', 'POST', {
      timeRange: el('range').value,
    }));
  });

  action('saved', async () => {
    show(await api(
      '/spotify/taste?timeRange=' +
      encodeURIComponent(el('range').value)
    ));
  });

  action('disconnect', async () => {
    show(await api('/spotify/disconnect', 'DELETE'));
  });
})();
</script>
</html>`;