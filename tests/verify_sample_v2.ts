import fs from 'fs';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { EpubService } from '../services/epubService';
import { FootnotePool } from '../services/footnotePool';

async function verifySampleV2() {
  console.log('--- Verifying sample_footnote_test_v2.epub ---');
  const buffer = fs.readFileSync('sample_footnote_test_v2.epub');
  const service = new EpubService();
  const parsed = await service.parseEpub(buffer as any);

  console.log(`Parsed chapters count: ${parsed.chapters.length}`);
  assert.equal(parsed.chapters.length, 4, 'Should have 3 body chapters + 1 notes source');

  const ch1 = parsed.chapters[0];
  const ch2 = parsed.chapters[1];
  const ch3 = parsed.chapters[2];
  const notesCh = parsed.chapters[3];

  assert.equal(notesCh.isFootnoteSource, true, 'notes.xhtml should be footnote source');
  assert.equal(notesCh.isSystemProtected, true, 'notes.xhtml should be system protected');

  assert.equal(Object.keys(ch1.internalizedFootnotes || {}).length, 1, 'Ch1 should have 1 footnote');
  assert.equal(Object.keys(ch2.internalizedFootnotes || {}).length, 3, 'Ch2 should have 3 footnotes');
  assert.equal(Object.keys(ch3.internalizedFootnotes || {}).length, 2, 'Ch3 should have 2 footnotes');

  // Translate with simulated LLM single-pass and two-step responses
  const pool = new FootnotePool();
  const mockTranslate = async (payload: string): Promise<string> => {
    return payload
      .replace(/Most people move through life focused solely on the immediate challenges right in front of them/g, '大多数人度过一生时，只关注眼前直接面临的挑战')
      .replace(/When we step back and zoom out, the trajectory of our entire year comes into vivid clarity/g, '当我们后退一步纵观全局时，整整一年的轨迹便清晰可见')
      .replace(/Perspective is not just a passive lens; it is an active practice that shapes our daily priorities and emotional well-being\./g, '视角不仅是一种被动的透镜，更是一种塑造我们日常优先级和情绪健康的积极实践。')
      .replace(/Establishing an annual reflection ritual creates a psychological clean slate known as the Fresh Start Effect/g, '建立年度反思仪式会创造一种被称为“新起点效应”的心理契机')
      .replace(/Rather than cramming your review into a single grueling day, many practitioners prefer spreading the process over several relaxed weeks/g, '许多实践者更愿意将反思过程分散到轻松的数周内，而不是压缩在令人精疲力竭的单日中')
      .replace(/In fact, recent surveys reveal that over two-thirds of first-time reviewers had never conducted a structured review before/g, '事实上，近期调查显示，超过三分之二的初次回顾者此前从未进行过结构化回顾')
      .replace(/Accountability and companionship make the review journey far more enjoyable and sustainable/g, '同伴的相互监督与陪伴让回顾之旅更加愉悦且具有持续性')
      .replace(/For more concrete examples and companion tools, explore our online repository/g, '如需更多具体范例和配套工具，请浏览我们的在线资源库')
      .replace(/By analogy to peak resource extraction, human attention has definitive limits that demand periodic replenishment\./g, '仿照资源开采峰值的说法，人类的注意力具有明确的极限，需要定期予以补充。')
      .replace(/Research by psychologist John C\. Norcross indicates that setting formal resolutions at temporal landmarks increases success rates tenfold compared to informal desires\./g, '心理学家约翰·C·诺克罗斯的研究表明，在时间节点设立正式决心，其成功率是非正式愿望的十倍。')
      .replace(/Lauren Forte observes that shifting the review period around the Lunar New Year provides greater psychological distance from holiday stress\./g, '劳伦·福特观察到，将回顾期调整到农历新年左右，能更好地与节日压力拉开心理距离。')
      .replace(/In a comprehensive survey of over 500 students, 69 percent had never maintained a regular year-end reflection practice\./g, '在对500多名学生的综合调查中，69%的人从未保持过定期的年终反思习惯。')
      .replace(/Community review groups show an 82 percent higher completion rate when paired with an accountability partner\./g, '当配备监督伙伴时，社群回顾小组的完成率高出82%。')
      .replace(/See the Annual Review Toolkit at https:\/\/lifeinperspective\.com\/toolkit for free downloadable templates and audio guides\./g, '请参阅 https://lifeinperspective.com/toolkit 上的“年度回顾工具包”，获取免费可下载的模板和音频指南。');
  };

  for (const ch of [ch1, ch2, ch3]) {
    const res = await pool.translateChapterWithPool(
      ch.content,
      ch.internalizedFootnotes || {},
      mockTranslate
    );
    ch.translatedMarkdown = res.slottedTranslatedMarkdown;
    ch.proofreadMarkdown = res.slottedTranslatedMarkdown;
    ch.translatedFootnotes = res.translatedFootnotes;
  }

  // Export EPUB 3
  const origZip = await new JSZip().loadAsync(buffer);
  const blob = await service.generateEpub(
    parsed.chapters,
    origZip,
    parsed.opfPath,
    parsed.opfDir,
    parsed.cssFiles,
    'TransLit Footnote Test Sample v2',
    'Chinese (Simplified)'
  );

  const outBuf = await blob.arrayBuffer();
  const outZip = await new JSZip().loadAsync(outBuf);

  // Verify all chapters have aside footnotes
  for (let i = 1; i <= 3; i++) {
    const file = outZip.file(`OEBPS/Text/ch0${i}.xhtml`);
    assert.ok(file, `ch0${i}.xhtml must exist in output EPUB`);
    const html = await file.async('string');
    assert.ok(html.includes('class="footnote-popup"'), `ch0${i}.xhtml must contain footnote-popup aside`);
    assert.ok(html.includes('class="noteref"'), `ch0${i}.xhtml must contain noteref anchor`);
    assert.ok(html.includes('class="footnote-backref"'), `ch0${i}.xhtml must contain footnote-backref`);
    // Ensure text has Chinese translation
    assert.ok(/[\u4e00-\u9fa5]/.test(html), `ch0${i}.xhtml must contain Chinese characters`);
  }

  // Verify 0-Offset placeholder for notes.xhtml
  const notesOut = await outZip.file('OEBPS/Text/notes.xhtml')!.async('string');
  assert.ok(notesOut.includes('data-zero-offset="true"'), 'notes.xhtml must be 0-Offset placeholder');

  // Verify Two-Step with header and single-pass formatting in AiService.parseResponse
  const { AiService } = await import('../services/geminiService');
  const aiService = new AiService({
    apiKey: 'mock',
    baseUrl: 'https://mock.api',
    modelName: 'mock-model',
    sourceLanguage: 'English',
    additionalContext: '',
    enableProofreading: true,
    useRecommendedPrompts: true,
    smartSkip: true,
    enableGlossary: true
  });

  // Test Two-Step response with heading line (must not erase paragraphs!)
  const twoStepRaw = `<think>pondering</think>
<translation_draft>
初译正文... __FN_REF_1-1__
[FN_DEF:1-1]
初译脚注1
[/FN_DEF]
</translation_draft>
<translation>
### 第二步：最终审校润色
第一段正文。 __FN_REF_1-1__

第二段正文。

第三段正文。

[FN_DEF:1-1]
润色后的脚注1
[/FN_DEF]
</translation>`;

  const parsedTwoStep = (aiService as any).parseResponse(twoStepRaw);
  assert.ok(parsedTwoStep.translation.includes('第一段正文。'), 'Two-step parsing must NOT wipe paragraph 1');
  assert.ok(parsedTwoStep.translation.includes('第二段正文。'), 'Two-step parsing must NOT wipe paragraph 2');
  assert.ok(parsedTwoStep.translation.includes('第三段正文。'), 'Two-step parsing must NOT wipe paragraph 3');
  assert.ok(!parsedTwoStep.translation.includes('### 第二步'), 'Heading must be stripped');

  // Test Single-pass response with footnote in translation tag
  const singlePassRaw = `<translation>
单步正文内容。 __FN_REF_0-1__

[FN_DEF:0-1]
单步翻译的脚注1内容
[/FN_DEF]
</translation>`;
  const parsedSinglePass = (aiService as any).parseResponse(singlePassRaw);
  assert.ok(parsedSinglePass.translation.includes('单步正文内容。'), 'Single pass body must be retained');
  assert.ok(parsedSinglePass.translation.includes('[FN_DEF:0-1]'), 'Single pass footnote must be retained');

  console.log('✓ sample_footnote_test_v2.epub verified successfully across all chapters, single-pass & two-step parsing, and footnote popups!');
}

verifySampleV2().catch((err) => {
  console.error(err);
  process.exit(1);
});
