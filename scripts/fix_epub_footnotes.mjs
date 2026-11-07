import fs from 'fs';
import JSZip from 'jszip';

const translations = {
  'fn-8-2': '我妻子劳伦觉得年末假期对她做回顾来说太匆忙了，所以她往往选择在农历新年左右来完成，具体时间视年份在1月21日至2月20日之间。这也让她与过去一年的经历拉开更大的心理距离，从而有足够的时间看清其真正的意义。',
  'fn-8-3': '在我最近对学生做的一项调查中，69%的人以前没有定期做年终回顾的习惯，超过三分之一的人更是从未做过。他们开始时没有任何模板，也没有任何经验——而他们中许多人写出的回顾，却是我读过最动人、最独具匠心的作品。',
  'fn-9-1': '让你的年度回顾更加愉悦的最佳方法之一，就是与他人同行。如果你想寻找一个围绕年度回顾的实践社群，可以免费加入我们的社区：lifeinperspective.com/community/ch3。',
  'fn-9-2': '如需收看对凯利的深度访谈，请查看我在 YouTube 上对她的专访：https://www.youtube.com/watch?v=EA4tO8RKTTs。',
  'fn-10-1': '如果今年最需要关注的领域恰好是你的工作、职业或事业，本书末尾（第13章）提供了一份可选的补充内容，包含一套专为回顾职业生涯而设计的练习。你可以将它们融入回顾中，也可以跳过它们，或者留到你特别想专注于职场生活的那一年再做。',
  'fn-10-2': '相互监督对完成年度回顾大有裨益，为此我们专门创建了一个免费社区。欢迎访问我们的网站 lifeinperspective.com/community/ch4 加入，并邀请你的朋友、伴侣或同事一同参与。',
  'fn-15-1': '你可以在我的 YouTube 频道查看这部纪录片范例：https://www.youtube.com/watch?v=HEjbE688EVw&t=1s。',
  'fn-22-1': '若想体验更加身临其境、更直观的可视化引导，可以使用“年度回顾工具包”（lifeinperspective.com/toolkit/ch9）中的引导视频，与我一同实时完成练习。',
  'fn-23-2': '“健康”就是我所称的“责任领域”（Area of Responsibility）——也就是你生活中需要持续维护而非彻底完成的领域。与项目不同，它没有终点线；它只会一直延续。如果你想进一步了解这个框架，我在《打造第二大脑》（Building a Second Brain）和《PARA方法》（The PARA Method）两本书中对“项目”与“领域”的区别做了更深入的阐述。',
  'fn-23-3': '“将来/也许”（someday/maybe）清单由生产力专家兼作家戴维·艾伦（David Allen）在其经典著作《搞定》（Getting Things Done）中普及，用来暂存那些你未来想考虑、但眼下无法推进的项目。',
  'fn-23-4': '请访问 lifeinperspective.com/toolkit/ch10 查看“年度回顾工具包”，其中包含一个基于 AI 的工具，它能通过个性化指导带领你完成本章阐述的三步流程。',
  'fn-28-1': '运动追踪应用 Strava 分析了其用户的8亿条数据点，将1月19日命名为“放弃日”（Quitters’ Day），因为从统计学来看，大多数人都在这一天放弃了锻炼习惯。这与我和许多学生的经验高度吻合。来源：https://runningmagazine.ca/the-scene/quitters-day-why-strava-thinks-youre-about-to-give-up-your-resolution/。',
  'fn-28-3': '我们在在线社区中设立了专门的交流空间，帮助你结识来自世界各地的回顾伙伴。你可以使用我们专用的 iOS 和 Android 应用，在 lifeinperspective.com/community/ch12 免费加入。',
  'fn-28-4': '如果你希望获得我的指导来了解具体做法，请参阅我的著作《打造第二大脑》（Building a Second Brain），该书详细介绍了如何构建一套全面的个人知识管理系统。',
  'fn-29-1': 'https://www.numeric.io/blog/closing-month-of-accounting-year'
};

async function fixEpubFootnotes() {
  const epubPath = 'Life in Perspective - Tiago Forte【TransLit】.epub';
  const data = fs.readFileSync(epubPath);
  const zip = await JSZip.loadAsync(data);

  let updatedCount = 0;
  const files = Object.keys(zip.files).filter(f => f.includes('/ch') && f.endsWith('.xhtml'));

  for (const filename of files) {
    let content = await zip.file(filename).async('string');
    let fileChanged = false;

    for (const [fnId, zhText] of Object.entries(translations)) {
      if (content.includes(`id="${fnId}"`)) {
        // Regex to match the aside block for this fnId:
        // <aside id="fnId" ...> ... <a href="#fnref-..." class="footnote-backref">...</a> ... </aside>
        const asideRegex = new RegExp(
          `(<aside\\s+id="${fnId}"[\\s\\S]*?<a\\s+href="#fnref-[^"]+"\\s+class="footnote-backref">[^<]+<\\/a>)([\\s\\S]*?)(<\\/p>\\s*<\\/aside>)`,
          'i'
        );

        if (asideRegex.test(content)) {
          content = content.replace(asideRegex, `$1 ${zhText}$3`);
          fileChanged = true;
          updatedCount++;
          console.log(`Updated ${fnId} in ${filename}`);
        }
      }
    }

    if (fileChanged) {
      zip.file(filename, content);
    }
  }

  console.log(`Total footnotes updated: ${updatedCount}`);
  const newBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });

  fs.writeFileSync(epubPath, newBuffer);
  console.log(`Saved updated EPUB to ${epubPath}`);
}

fixEpubFootnotes().catch(console.error);
