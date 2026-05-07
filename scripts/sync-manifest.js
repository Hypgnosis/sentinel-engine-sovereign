import fs from 'fs';
import { VERSION, CODENAME } from '../functions/shared/constants.js';

const filesToSync = [
  './README.md', 
  './MANIFEST.md',
  './dashboard/src/components/ActiveFeed.jsx'
];

filesToSync.forEach(path => {
  if (!fs.existsSync(path)) {
    console.warn(`File not found: ${path}`);
    return;
  }
  let content = fs.readFileSync(path, 'utf8');
  
  // Replace standard Markdown versions
  content = content.replace(/Version:\s*[^\n\r]+/g, `Version: ${VERSION}`);
  content = content.replace(/Codename:\s*[^\n\r]+/g, `Codename: ${CODENAME}`);
  
  // Replace React Component metadata
  content = content.replace(
    /Engine Version:\s*[^\n\r<]+/gi, 
    `Engine Version: ${VERSION}`
  );

  fs.writeFileSync(path, content);
  console.log(`Synced versioning to ${path}`);
});
