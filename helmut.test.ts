import { describe, expect, test } from "bun:test";
import { parseHelmutHtml, parsePlainTextSplits } from "./helmut";

describe("parseHelmutHtml", () => {
  test("parses Helmut WordPress markup into splits", () => {
    const html = `
      <html>
        <body>
          <div class="entry-content">
            <p>
              start<br>
              1 km: 2:44 ; last km: 2:44 ; proj: 0:27:19<br>
              2 km: 5:25 ; last km: 2:41 ; proj: 0:27:07
            </p>
          </div>
        </body>
      </html>
    `;

    expect(parseHelmutHtml(html)).toEqual([
      { km: 1, split: "2:44", last_km: "2:44", projected_finish: "27:19" },
      { km: 2, split: "5:25", last_km: "2:41", projected_finish: "27:07" },
    ]);
  });

  test("resets to the latest run when kilometers go backwards", () => {
    const html = `
      <div class="entry-content">
        <p>
          start<br>
          1 km: 2:50 ; last km: 2:50 ; proj: 0:28:20<br>
          2 km: 5:39 ; last km: 2:49 ; proj: 0:28:15<br>
          1 km: 2:44 ; last km: 2:44 ; proj: 0:27:19
        </p>
      </div>
    `;

    expect(parseHelmutHtml(html)).toEqual([
      { km: 1, split: "2:44", last_km: "2:44", projected_finish: "27:19" },
    ]);
  });
});

describe("parsePlainTextSplits", () => {
  test("parses simulation text fixtures", () => {
    const text = `
      start
      1 km: 2:44 ; last km: 2:44 ; proj: 0:27:19
      2 km: 5:25 ; last km: 2:41 ; proj: 0:27:07
    `;

    expect(parsePlainTextSplits(text)).toEqual([
      { km: 1, split: "2:44", last_km: "2:44", projected_finish: "27:19" },
      { km: 2, split: "5:25", last_km: "2:41", projected_finish: "27:07" },
    ]);
  });
});
