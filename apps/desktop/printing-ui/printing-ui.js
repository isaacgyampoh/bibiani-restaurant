/* MY FOOD Printing window. Talks to the app only through window.printing (see preload). */
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
};
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function render() {
  const s = await window.printing.status();
  $('title').textContent = s.title;
  $('version').textContent = `Version ${s.version} · ${s.cloud}`;
  const pill = $('pill');
  const problems = s.printers.filter((p) => !p.reachable).length;
  if (s.phase === 'pairing') {
    pill.textContent = 'Not connected yet';
    pill.className = 'pill warn';
  } else if (s.phase === 'error' || s.cloud === 'unreachable') {
    pill.textContent = s.phase === 'error' ? 'Not connected' : 'No internet';
    pill.className = 'pill bad';
  } else if (problems) {
    pill.textContent = `${problems} printer${problems === 1 ? '' : 's'} not reachable`;
    pill.className = 'pill bad';
  } else {
    pill.textContent = 'Printing is on';
    pill.className = 'pill ok';
  }

  $('pairing').hidden = s.phase !== 'pairing';
  if (s.pairing) {
    $('code').textContent = s.pairing.code;
    const left = Math.max(1, Math.round((Date.parse(s.pairing.expiresAt) - Date.now()) / 60_000));
    $('codeNote').textContent =
      `Waiting for the code to be entered… (the code works for about ${left} more minute${left === 1 ? '' : 's'}; a new one then appears)`;
  } else {
    $('code').textContent = '…';
  }
  $('message').hidden = !s.message;
  $('message').textContent = s.message ?? '';

  $('running').hidden = s.phase === 'pairing';
  if (s.device) {
    $('runningTitle').textContent =
      s.phase === 'running' ? `Printing is on · ${s.device.name}` : s.device.name;
    $('runningNote').textContent =
      s.cloud === 'unreachable'
        ? 'MY FOOD cannot be reached right now. Print jobs wait in MY FOOD and print when the connection is back.'
        : `Connected to MY FOOD${s.lastContactAt ? ` · checked ${time(s.lastContactAt)}` : ''}. Keep this PC switched on during service.`;
  }
  const body = $('printers');
  body.replaceChildren(
    ...s.printers.map((p) =>
      el(
        'tr',
        {},
        el('td', {}, el('b', { textContent: p.name })),
        el('td', { textContent: p.connection === 'usb_escpos' ? 'USB (this PC)' : 'Network' }),
        el('td', { textContent: p.address ?? '—' }),
        el('td', {
          className: p.reachable ? 'ok' : 'bad',
          textContent: p.reachable ? 'Ready' : `Not reachable: ${p.error ?? ''}`,
        }),
        el('td', {}, testButton(p.connection, p.address, p.paperWidthMm)),
      ),
    ),
  );
  $('noPrinters').hidden = s.phase === 'pairing' || s.printers.length > 0;
  $('recent').replaceChildren(
    ...(s.recent.length
      ? s.recent.map((r) =>
          el('li', { className: r.ok ? '' : 'bad', textContent: `${time(r.at)}  ${r.text}` }),
        )
      : [el('li', { className: 'muted', textContent: 'Nothing yet.' })]),
  );
}

function testButton(connection, address, width) {
  const b = el('button', { textContent: 'Print test page', disabled: !address });
  b.onclick = async () => {
    b.disabled = true;
    b.textContent = 'Printing…';
    try {
      const r = await window.printing.test({
        connection,
        address,
        paperWidthMm: Number(width ?? $('width').value),
      });
      b.textContent = r.ok ? 'Sent ✓' : 'Failed';
    } catch (e) {
      b.textContent = 'Failed';
    }
    setTimeout(() => {
      b.textContent = 'Print test page';
      b.disabled = false;
    }, 3000);
    void render();
  };
  return b;
}

function copyButton(text) {
  const b = el('button', { textContent: 'Copy' });
  b.onclick = async () => {
    await window.printing.copy(text);
    b.textContent = 'Copied';
    setTimeout(() => (b.textContent = 'Copy'), 2000);
  };
  return b;
}

$('scan').onclick = async () => {
  const b = $('scan');
  b.disabled = true;
  b.textContent = 'Searching (about 10 seconds)…';
  try {
    const found = await window.printing.scan();
    $('found').replaceChildren(
      el('p', {
        className: 'muted',
        textContent: found.length
          ? 'Printers answering on this network. Print a test page to see which is which:'
          : 'No network printer answered. Check the printer is switched on and connected to the same network (cable or Wi-Fi) as this PC. A printer\'s own "self-test" page (hold FEED while switching it on) usually shows its IP address.',
      }),
      ...found.map((f) =>
        el(
          'div',
          { className: 'found-item' },
          el('code', { textContent: f.address }),
          copyButton(f.address),
          testButton('network_escpos', f.address),
        ),
      ),
    );
  } finally {
    b.disabled = false;
    b.textContent = 'Search the network';
  }
};

$('usb').onclick = async () => {
  const list = await window.printing.usb();
  $('found').replaceChildren(
    el('p', {
      className: 'muted',
      textContent: list.length
        ? 'Printers installed in Windows on this PC. Receipt printers plugged in by USB show "USB". Use the name exactly as shown:'
        : 'Windows has no printers installed. Plug the USB printer in, install its Windows driver (from the printer maker), then try again.',
    }),
    ...list.map((p) =>
      el(
        'div',
        { className: 'found-item' },
        el('code', { textContent: p.name }),
        el('span', { className: 'muted', textContent: p.usb ? 'USB' : p.port }),
        copyButton(p.name),
        testButton('usb_escpos', p.name),
      ),
    ),
  );
};

$('forget').onclick = () => void window.printing.forget();

void render();
setInterval(() => void render(), 2000);
