"""Builds the picture-led Hub Guide HTML. Usage: python hub_guide.py <out.html>
Pictures: docs/manual/guide-images (e2e-hub/zz-hub-guide.spec.ts and e2e/zz-installer-guide.spec.ts)."""
import sys

from guide_style import SMARTSCREEN, Guide

g = Guide()
g.page('''<div class="cover">
<div class="brand">MY FOOD</div>
<h1>Hub Guide<br><span>connect the desktop Hub, with pictures</span></h1>
<p class="lead">The <b>MY FOOD Hub</b> is a Windows program that runs the restaurant on one PC inside the restaurant.
Tills, kitchen screens, printers and the customer display then <b>keep working when the internet is down</b>.</p>
<div class="box"><b>You need:</b><ul>
<li>One Windows 10/11 PC that stays <b>on during opening hours</b>, connected <b>by cable</b> to the router</li>
<li>Internet for the first setup</li>
<li>The owner or a manager signed in to MY FOOD on their phone or laptop</li>
<li>A manager’s PIN (to connect tills in the Hub window)</li>
<li>Tills, screens and printers on the <b>same Wi-Fi / network</b> as the Hub PC</li></ul></div>
<div class="tip"><b>Test it before a busy service.</b> The Hub has been tested in software but not yet on the restaurant’s own PCs.</div>
<p class="small">Red boxes and arrows show exactly what to press. Pictures are from the MY FOOD test system: names, numbers and addresses on your screens will be different.</p>
</div>''')

g.page('''<div class="part">BEFORE YOU START</div><h2 class="h">How it fits together</h2>
<div class="diagram">
  <div class="node cloud">MY FOOD (internet)<br><small>www.chefelisha.cc · back office, reports</small></div>
  <div class="down">▲▼ <small style="font-size:11pt;color:#444">sends and receives when the internet works</small></div>
  <div class="node print">MY FOOD Hub PC<br><small>HUB-01 · always on · cable to router</small></div>
  <div class="down">▼</div>
  <div class="node router">Restaurant Wi-Fi / router</div>
  <div class="down">▼</div>
  <div class="row4">
    <div class="node">Tills</div><div class="node">Kitchen screens</div><div class="node">Customer display</div><div class="node">Printers<br><small>the Hub prints</small></div>
  </div>
</div>
<div class="box">With the Hub, tills open <b>the Hub’s address</b> (for example <b>http://192.168.1.20:8080</b>) instead of www.chefelisha.cc.
MY FOOD Printing is <b>not needed</b>: the Hub prints.</div>''')

A = 'PART 1 · INSTALL THE HUB'
g.step(A, 'Add the Hub in MY FOOD',
       'On the manager’s phone or laptop: <b>Devices &amp; printing</b> → <b>Add device</b>. Name <b>HUB-01</b>, Type <b>MY FOOD Hub</b> → <b>Add device</b>.',
       'hb2-add-hub-device')
g.step(A, 'On the Hub PC: download MY FOOD Hub',
       'On the Hub PC, sign in to MY FOOD → <b>Devices &amp; printing</b> → <b>MY FOOD Hub for Windows</b> → <b>Download for Windows</b>. Download the file <b>MY-FOOD-Hub-Setup-…-production.exe</b>.',
       'hb1-download-hub')
g.step(A, 'Install it (Windows warning)',
       'Open the downloaded file. Windows may show a blue warning. Click <b>More info</b>. A <b>Run anyway</b> button then appears: click it.',
       extra=SMARTSCREEN,
       tip='MY FOOD Hub then opens by itself and <b>starts with Windows</b> every day. Closing its window keeps it running (icon next to the clock).')

B = 'PART 2 · CONNECT THE HUB'
g.step(B, 'The Hub window shows a code',
       'The first time, the Hub window says <b>Connect this hub to MY FOOD</b> and shows a code.', 'h1-hub-shows-code')
g.step(B, 'Enter that code ONLY on the HUB-01 row',
       'On the manager’s phone: <b>Devices &amp; printing</b> → the <b>HUB-01</b> row → <b>Enter code from device</b> → type the code → <b>Pair device</b>.',
       'hb3-hub-row-enter-code', '<b>Never</b> enter the Hub’s code on a till’s row. MY FOOD refuses it, and nothing changes.')
g.step(B, 'Let the Hub run the restaurant',
       'Only when the Hub window says <b>Connected</b>: on the same <b>HUB-01</b> row press <b>Run branch from hub</b> and confirm. Finish all open orders on the tills first.',
       'hb4-run-branch-from-hub',
       'From now on the tills must open <b>the Hub’s address</b>. To go back, a manager presses <b>Stop running branch</b> on the HUB-01 row.')
g.step(B, 'Check the Hub window',
       'The Hub window now shows <b>Connected</b>, <b>All sent</b> and <b>Runs this branch: Yes</b>.', 'h3-hub-connected')
g.step(B, 'Write down the Hub’s address',
       'The Hub window shows the address the tills must open (for example <b>http://192.168.1.20:8080</b>). Write it down.',
       'h4-hub-address', 'Ask whoever manages the router to <b>reserve</b> this address for the Hub PC, so it never changes.')

C = 'PART 3 · CONNECT TILLS AND SCREENS TO THE HUB'
g.step(C, 'On the till: open the Hub’s address',
       'On each till, open Chrome and type the Hub’s address followed by <b>/pair</b> (for example <b>http://192.168.1.20:8080/pair</b>). The till shows a code.',
       'h5-till-shows-code')
g.step(C, 'In the Hub window: find the till',
       'On the <b>Hub PC</b>, in the Hub window, find the till’s name under <b>Devices</b> and press <b>Enter code from device</b>.',
       'h6-hub-enter-code')
g.step(C, 'Code + manager PIN → Connect device',
       'Type the code from the till and a <b>manager’s PIN</b>, then press <b>Connect device</b>.', 'h7-hub-connect-device',
       'Nobody else should watch while the PIN is typed.')
g.step(C, 'Done: the till works through the Hub',
       'The till continues by itself to <b>Enter your staff PIN</b>. Repeat for every till, kitchen screen and the customer display. Kitchen screens work the same way: <b>ACCEPT → START → READY → DONE</b>.',
       'h8-till-ready', 'Printers: set them up in <b>Devices &amp; printing</b> as in the Installer Guide, with <b>Printed by</b> = <b>HUB-01</b>.')

D = 'PART 4 · INTERNET TEST'
g.step(D, 'Unplug the internet: the till keeps working',
       'Unplug the internet cable from the router (not the Hub’s cable). The till shows a yellow line <b>Offline · everything keeps working and is saved on the hub</b>. Make a test order: it still works and prints.',
       'h9-offline-till')
g.step(D, 'The Hub window while offline',
       'The Hub window shows <b>Offline</b> and the number of changes <b>waiting</b>. This is normal.', 'h10-hub-offline')
g.step(D, 'Plug the internet back in',
       'Within a minute the Hub sends everything and shows <b>All sent</b>. The order appears in MY FOOD’s reports. Nothing is sent twice.',
       'h11-hub-all-sent')

g.page('''<div class="part">REMEMBER</div><h2 class="h">Hub rules</h2>
<div class="cols"><div class="yes"><h3>✔ DO</h3><ul>
<li>Keep the Hub PC <b>on</b> and plugged in by cable (a UPS battery is best)</li>
<li>Restart it with Windows <b>Restart</b>: everything reconnects by itself</li>
<li>Staff sign in once on the Hub <b>while online</b>, so their PIN also works offline</li>
<li>Check the Hub window says <b>All sent</b> before closing for the day</li></ul></div>
<div class="no"><h3>✘ DON’T</h3><ul>
<li>Don’t choose <b>Quit (tills stop working)</b> in the tray menu during service</li>
<li>Don’t turn the Hub PC off while the restaurant is open</li>
<li>Don’t <b>Revoke</b> the Hub while it runs the branch unless you mean to stop using it (the branch then goes back to the web POS)</li>
<li>Don’t delete anything if it says <b>Needs attention</b>: call support</li>
<li>Don’t enter the Hub’s code on any row except <b>HUB-01</b></li></ul></div></div>
<div class="box"><b>Tray menu</b> (icon next to the clock): <b>Open MY FOOD Hub</b> · <b>Open a till on this computer</b> · <b>Quit (tills stop working)</b>.<br>
In the Hub’s own window: <b>F1</b> = point of sale, <b>F2</b> = Hub status and devices.</div>''')

g.page('''<div class="part">IF SOMETHING IS WRONG</div><h2 class="h">Quick fixes</h2>
<table><tr><th>You see</th><th>Do this</th></tr>
<tr><td>A till can’t open the Hub’s address</td><td>Is the Hub PC on? Is the till on the <b>same Wi-Fi</b>? Check the address in the Hub window (it may have changed).</td></tr>
<tr><td>Till on www.chefelisha.cc says “This branch is run by its MY FOOD Hub…”</td><td>Open the Hub’s address on that till, or a manager presses <b>Stop running branch</b> on the HUB-01 row.</td></tr>
<tr><td>Windows asks to allow MY FOOD Hub on the network</td><td>Choose <b>Allow</b> (private networks).</td></tr>
<tr><td>Hub window: <b>Offline</b></td><td>Only the internet is down. Keep working; it sends everything later.</td></tr>
<tr><td>Hub window: <b>Needs attention</b></td><td>Don’t delete anything. Take a photo and call support.</td></tr>
<tr><td>Staff PIN not accepted while offline</td><td>That person has not signed in on the Hub before while online. A manager signs them in when the internet is back.</td></tr>
<tr><td>The Hub PC is broken during service</td><td>If the internet works: manager’s phone → <b>Devices &amp; printing</b> → HUB-01 row → <b>Stop running branch</b>. Tills then open <b>www.chefelisha.cc</b> again.</td></tr>
<tr><td>“Port 8080 is used by another program”</td><td>Close the other program, or call support.</td></tr>
</table>
<div class="box"><b>Still stuck?</b> Take a photo of the screen (no PINs) and call:<br><br>
MY FOOD support: ________________________ &nbsp;&nbsp; Manager: ________________________</div>''')

g.write(sys.argv[1])
