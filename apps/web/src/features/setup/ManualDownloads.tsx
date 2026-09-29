/**
 * The official manual and installer sheets (docs/manual), copied into every deployed build under
 * /manual/ by scripts/deploy/build-vercel.mjs. They contain no secrets.
 */
const FILES = [
  [
    'MY-FOOD-Installer-Guide-with-Pictures.pdf',
    'Installer Guide with pictures',
    'PDF · step by step, easy to share',
  ],
  [
    'MY-FOOD-Hub-Guide-with-Pictures.pdf',
    'Hub Guide with pictures',
    'PDF · connect the desktop Hub (works offline)',
  ],
  ['MY-FOOD-Installation-and-Operations-Manual.pdf', 'Installation & Operations Manual', 'PDF · full manual'],
  ['MY-FOOD-Quick-Reference.pdf', 'Quick Reference', 'PDF · one page for every till'],
  ['MY-FOOD-Installer-Checklist.pdf', 'Installer Checklist', 'PDF · two pages, with sign-off'],
  ['MY-FOOD-Device-Register.xlsx', 'Device Register', 'Excel · list of devices and printers'],
] as const;

export function ManualDownloads() {
  return (
    <section className="card hub-download" aria-labelledby="manual-downloads-title">
      <h2 id="manual-downloads-title">Manual and checklists</h2>
      <p>How to install, pair devices, set up printing and run the restaurant day to day.</p>
      <ul className="manual-downloads">
        {FILES.map(([file, title, what]) => (
          <li key={file}>
            <div className="grow">
              <strong>{title}</strong>
              <div className="small muted">{what}</div>
            </div>
            <a className="btn sm" href={`/manual/${file}`} download={file}>
              Download
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
