"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ARTICLES, CATEGORIES, readingMinutes } from "@/lib/learn-content";
import { useI18n } from "@/lib/i18n";

export default function ArticlePage() {
  const { lang } = useI18n();
  const params = useParams<{ slug: string }>();
  const say = (zh: string, en: string, ms: string) => (lang === "en" ? en : lang === "ms" ? ms : zh);
  const article = ARTICLES.find((a) => a.slug === params.slug);
  if (!article) {
    return (
      <Shell>
        <div className="page learn-article"><p className="hint">{say("文章不存在", "Article not found", "Artikel tidak dijumpai")}</p><Link href="/learn">‹ {say("返回学习中心", "Back to Learn", "Kembali")}</Link></div>
      </Shell>
    );
  }
  const cat = CATEGORIES.find((c) => c.id === article.cat)!;
  const related = ARTICLES.filter((a) => a.cat === article.cat && a.slug !== article.slug).slice(0, 3);
  return (
    <Shell>
      <div className="page learn-article">
        <nav className="learn-crumbs"><Link href="/learn">{say("学习中心", "Learn", "Pusat pembelajaran")}</Link> › <span>{say(cat.zh, cat.en, cat.ms)}</span></nav>
        <article className="learn-body">
          <h1>{article.title}</h1>
          <p className="hint learn-meta">{say(`约 ${readingMinutes(article)} 分钟阅读`, `${readingMinutes(article)} min read`, `${readingMinutes(article)} min bacaan`)} · {say("更新于", "Updated", "Dikemas kini")} {article.updated}</p>
          <p className="learn-summary">{article.summary}</p>
          {article.body.map((b, i) => (
            <div key={i}>
              {b.h ? <h2>{b.h}</h2> : null}
              {b.p ? <p>{b.p}</p> : null}
              {b.ul ? <ul>{b.ul.map((li) => <li key={li}>{li}</li>)}</ul> : null}
              {b.warn ? <p className="learn-warn">⚠ {b.warn}</p> : null}
            </div>
          ))}
          <p className="hint learn-disclaimer">{say("本文仅供教育参考，不构成投资、法律或税务建议。", "Education only; not investment, legal or tax advice.", "Pendidikan sahaja; bukan nasihat pelaburan.")}</p>
        </article>
        <aside className="learn-related">
          {related.length ? <b>{say("相关文章", "Related", "Berkaitan")}</b> : null}
          {related.map((a) => <Link key={a.slug} href={`/learn/${a.slug}`}>{a.title}</Link>)}
          <Link href="/learn" className="learn-back">‹ {say("返回学习中心", "Back to Learn", "Kembali")}</Link>
        </aside>
      </div>
    </Shell>
  );
}
