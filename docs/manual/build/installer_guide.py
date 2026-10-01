"""Builds the picture-led Installer Guide HTML. Usage: python installer_guide.py <out.html>
Pictures: docs/manual/guide-images (e2e/zz-installer-guide.spec.ts)."""
import sys

from guide_style import SMARTSCREEN, Guide

g = Guide()
g.page('''
<div class="cover">
<div class="brand">MY FOOD</div>
<h1>Installer Guide<br><span>with pictures</span></h1>
<p class="lead">How to connect the tills, printers, kitchen screens and customer display at <b>Chefelisha Restaurant</b>.</p>
<div class="box"><b>You need:</b>
<ul><li>Internet in the restaurant (Wi-Fi or cable)</li>
<li>The owner or a manager, signed in to MY FOOD on their phone or laptop</li>
<li>Each till / screen with <b>Google Chrome</b> or <b>Microsoft Edge</b></li>
<li>One Windows PC at the counter for printing (it can be a till)</li>
<li>Printers switched on, with paper</li></ul></div>
<div class="big">Address: <b>www.chefelisha.cc</b></div>
<p class="small">Follow the pages in order. Red boxes and arrows show exactly what to press.<br>
Pictures are from the MY FOOD test system: names and numbers on your screen will be slightly different.</p>
</div>''')

g.page('''
<div class="part">BEFORE YOU START</div><h2 class="h">How it fits together</h2>
<div class="diagram">
  <div class="node cloud">MY FOOD (internet)<br><small>www.chefelisha.cc</small></div>
  <div class="down">▼</div>
  <div class="node router">Restaurant Wi-Fi / router</div>
  <div class="down">▼</div>
  <div class="row4">
    <div class="node">Tills<br><small>POS-01, POS-02</small></div>
    <div class="node">Kitchen screens<br><small>KITCHEN-01, DRINKS-01</small></div>
    <div class="node">Customer display<br><small>CUSTOMER-DISPLAY-01</small></div>
    <div class="node print">Printing PC<br><small>PRINT-AGENT-01</small><div class="down">▼</div><div class="node inner">Printers<br><small>KITCHEN-PRINTER-01<br>RECEIPT-PRINTER-01</small></div></div>
  </div>
</div>
<div class="box"><b>Use these names.</b> Each device already has a row with its name in MY FOOD → <b>Devices &amp; printing</b>.
Stick a label with the name on each device so you always pair the right one.</div>''')

A = 'PART 1 · TILLS'
g.step(A, 'On the till: open the pairing page',
       'Open Chrome on the till and go to <b>www.chefelisha.cc/pair</b>. The till shows a code. Leave it on the screen.',
       'a1-till-shows-code', 'The code works for 10 minutes. <b>Do not press “Show a new code”.</b>')
g.step(A, 'On the manager’s phone: find the till’s row',
       'Open MY FOOD → <b>Devices &amp; printing</b>. Find the row with this till’s name (e.g. POS-01) and press <b>Enter code from device</b> on that row.',
       'a2-enter-code-on-till-row')
g.step(A, 'Type the code, press Pair device', 'Type the code exactly as the till shows it, then press <b>Pair device</b>.',
       'a3-type-code-pair')
g.step(A, 'Done: the till shows the PIN pad',
       'Within a few seconds the till continues by itself and shows <b>Enter your staff PIN</b>. Repeat steps 1–4 for every till, each on its own row.',
       'a4-till-ready', 'Restarting the till is fine. It stays paired.')

B = 'PART 2 · PRINTING'
g.step(B, 'On the printing PC: download MY FOOD Printing',
       'On the Windows PC at the counter, sign in to MY FOOD, open <b>Devices &amp; printing</b> and click <b>MY FOOD Printing</b> to download it.',
       'b1-download-printing')
g.step(B, 'Install it (Windows warning)',
       'Open the downloaded file <b>MY-FOOD-Printing-Setup.exe</b>. Windows may show a blue warning. Click <b>More info</b>. A <b>Run anyway</b> button then appears: click it.',
       extra=SMARTSCREEN,
       tip='This warning appears because the app is new, not because something is wrong. MY FOOD Printing then opens by itself and starts with Windows every day.')
g.step(B, 'MY FOOD Printing shows a code', 'The window says <b>Connect this PC to MY FOOD</b> and shows a code.', 'b2-printing-code')
g.step(B, 'Enter that code ONLY on PRINT-AGENT-01',
       'On the manager’s phone: <b>Devices &amp; printing</b> → the <b>PRINT-AGENT-01</b> row → <b>Enter code from device</b> → type the code → <b>Pair device</b>.',
       'b3-enter-code-on-agent-row', '<b>Never</b> enter this code on a till’s row. MY FOOD will refuse it, and nothing changes.')
g.step(B, 'Printing is on. Find the printers.',
       'The window says <b>Printing is on</b>. Press <b>Search the network</b> to see each printer’s address. <b>Print test page</b> checks each printer.',
       'b4-printing-is-on', 'Printer address tip: hold the printer’s FEED button while switching it on, and it prints its address.')
g.step(B, 'Put each printer’s address in MY FOOD',
       'In <b>Devices &amp; printing</b>, press <b>Edit</b> on each printer. Choose Network or USB, type the address, set <b>Printed by</b> to PRINT-AGENT-01, then <b>Save</b>.',
       'b5-edit-printer', 'An address ending in .1 (like 192.168.1.1) is usually the Wi-Fi router, not a printer.')
g.step(B, 'Test print from MY FOOD', 'Press <b>Test print</b> on each printer’s row. MY FOOD must say it <b>printed</b>.', 'b6-test-print')
g.step(B, 'Kitchen printers: connect to their station',
       'In <b>Stations &amp; routing</b>, choose the <b>Station</b> (e.g. Main Kitchen), the <b>printer</b> and the role <b>Main</b>, then press <b>Connect screen or printer</b>.',
       'b7-connect-station-printer')
g.step(B, 'Each till: choose its receipt printer',
       'In <b>Devices &amp; printing</b>, press <b>Edit</b> on each till, choose its <b>Receipt printer</b> and press <b>Save</b>. The till then also prints the customer’s <b>order number</b> slip.',
       'b8-till-receipt-printer')

C = 'PART 3 · KITCHEN SCREENS & CUSTOMER DISPLAY'
g.step(C, 'Same as the tills',
       'On each kitchen screen and on the customer display, open <b>www.chefelisha.cc/pair</b>. Enter the code on <b>its own row</b> (KITCHEN-01, DRINKS-01, CUSTOMER-DISPLAY-01…). It opens its screen by itself.',
       'c1-kitchen-row')
g.step(C, 'How the kitchen uses its screen',
       'Every new order arrives as <b>NEW ORDER</b>. The kitchen presses <b>ACCEPT</b> (“we have it”), then <b>START</b> when cooking begins, <b>READY</b> when the food is ready, and <b>DONE</b> to clear it.',
       'c2-kitchen-accept',
       extra='<div class="flow"><span>NEW ORDER</span><b>→</b><span class="a">ACCEPT</span><b>→</b><span>START</span><b>→</b><span>READY</span><b>→</b><span>DONE</span></div>',
       tip='A red <b>VOIDED · STOP PREPARATION</b> means the customer cancelled it: do not make it.')

D = 'PART 4 · FINAL TEST'
g.step(D, 'Make a test order',
       'On a till, sign in with a staff PIN → <b>Takeaway</b> → <b>+ New takeaway order</b> → tap a product → <b>Send to kitchen</b>. The kitchen screen shows it, the kitchen ticket prints, and the till prints the order number for the customer.',
       'd1-test-order')
g.step(D, 'Take payment', 'Press <b>Take payment</b> → <b>CASH</b> → type the money received → <b>Complete payment</b>.', 'd2-payment')
g.step(D, 'Print the receipt',
       'Press <b>Print receipt</b>. It prints on the till’s receipt printer. Then restart every device once and check it still works.',
       'd3-print-receipt')

g.page('''<div class="part">REMEMBER</div><h2 class="h">Pairing rules</h2>
<div class="cols"><div class="yes"><h3>✔ DO</h3><ul>
<li>Enter a device’s code on <b>that device’s row</b></li>
<li>Use the code that is on the screen <b>now</b></li>
<li>Printing code → only <b>PRINT-AGENT-01</b></li>
<li>Wait up to 10 seconds after <b>Pair device</b></li>
<li>Read the message if a code is refused</li></ul></div>
<div class="no"><h3>✘ DON’T</h3><ul>
<li>Don’t keep pressing <b>Show a new code</b> or <b>Create code</b></li>
<li>Don’t enter one device’s code on another device’s row</li>
<li>Don’t pair a device that already shows the PIN pad</li>
<li>Don’t send codes or PINs on WhatsApp</li></ul></div></div>
<div class="box"><b>“Create code”</b> is the other way round: that code is typed <b>on the device</b>, after pressing <b>I have a code from a manager</b>. You normally don’t need it.</div>''')

g.page('''<div class="part">IF SOMETHING IS WRONG</div><h2 class="h">Quick fixes</h2>
<table><tr><th>You see</th><th>Do this</th></tr>
<tr><td>“That pairing code has expired”</td><td>Use the new code the device shows now.</td></tr>
<tr><td>“This code comes from MY FOOD Printing…”</td><td>You used a till’s row. Enter it on <b>PRINT-AGENT-01</b>.</td></tr>
<tr><td>“That is a code created here in MY FOOD”</td><td>Type it <b>on the device</b> (“I have a code from a manager”).</td></tr>
<tr><td>Red box on Devices &amp; printing: “Printing has stopped”</td><td>Switch on the printing PC and check its internet. MY FOOD Printing must be running (icon near the clock).</td></tr>
<tr><td>Printer “Not reachable” / did not print</td><td>Power, paper, cable. Search the network again and fix the address with <b>Edit</b>.</td></tr>
<tr><td>Ticket prints in the wrong place</td><td><b>Stations &amp; routing</b>: check which printer is connected to that station.</td></tr>
<tr><td>Receipt shows on screen instead of printing</td><td>Edit the till → choose its <b>Receipt printer</b>.</td></tr>
<tr><td>Kitchen screen: “Press ACCEPT first”</td><td>Press <b>ACCEPT</b>, then <b>START</b>, then <b>READY</b>.</td></tr>
</table>
<div class="box"><b>Still stuck?</b> Stop making new codes. Take a photo of the screen (no PINs) and call:<br><br>
MY FOOD support: ________________________ &nbsp;&nbsp; Manager: ________________________</div>''')

g.write(sys.argv[1])
