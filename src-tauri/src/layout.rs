/**
 * 附属窗口的布局仲裁（D06）。
 *
 * 宠物周围挂着三样东西：对话条、摘要条、以及用户自己打开的插件页面窗口。前两样
 * 跟着宠物走，样子的差别只是「贴在上方还是下方」；后一样是独立的大窗口，可能停在
 * 屏幕任何地方。这一层只回答一个问题：**每个附属窗口该摆在哪**。
 *
 * 三个约束按优先级排：
 *
 * 1. **不许互相遮挡。** 一条摘要条压在对话条上，两个都点不到 —— 而它们都是用户
 *    主动叫出来的东西，遮住等于「点了没反应」。因此同侧的窗口首尾相接地堆叠，
 *    而不是各贴各的。
 * 2. **不许出工作区。** 高 DPI、第二块显示器、负坐标坐标系下，最容易出的事就是
 *    窗口算到了屏幕外：用户看到它消失了，只能靠重启找回。
 * 3. **宠物是锚点。** 附属窗口的位置由宠物决定，不反过来 —— 宠物是那个一直都在
 *    的东西，动它会让别的东西跟着动，而用户拖的通常就是它。
 *
 * **全部用物理像素。** 布局要在多显示器之间算，而各屏 DPI 可以不同；用逻辑像素
 * 算出来的坐标换个屏就错了（150% 的屏上 96 逻辑像素 = 144 物理像素）。
 */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn right(&self) -> i32 {
        self.x + self.width
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.height
    }

    pub fn intersects(&self, other: &Rect) -> bool {
        self.x < other.right()
            && other.x < self.right()
            && self.y < other.bottom()
            && other.y < self.bottom()
    }

    pub fn contains(&self, other: &Rect) -> bool {
        other.x >= self.x
            && other.y >= self.y
            && other.right() <= self.right()
            && other.bottom() <= self.bottom()
    }
}

pub fn clamp(value: i32, min: i32, max: i32) -> i32 {
    if max < min {
        return min;
    }
    value.max(min).min(max)
}

/// 附属窗口落在宠物的哪一侧。对话条是被叫出来才出现的，贴着下方最不挡事；
/// 摘要条是常驻的，压在上方才不会被宠物挡住，而宠物多半待在屏幕角落，上面更空。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Below,
    Above,
}

/// 一个待摆放的附属窗口。`size` 是物理像素。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    pub label: &'static str,
    pub width: i32,
    pub height: i32,
    pub prefer: Side,
}

impl Placement {
    pub fn new(label: &'static str, width: i32, height: i32, prefer: Side) -> Self {
        Self {
            label,
            width,
            height,
            prefer,
        }
    }

    fn at(&self, x: i32, y: i32) -> Rect {
        Rect::new(x, y, self.width, self.height)
    }
}

/// 一个附属窗口的最终位置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Positioned {
    pub label: &'static str,
    pub x: i32,
    pub y: i32,
}

/// 水平方向：居中于宠物，然后夹进工作区。宠物被拖到屏幕边缘外时这一步救场。
fn centered_x(anchor: Rect, width: i32, work: Rect) -> i32 {
    clamp(
        anchor.x + anchor.width / 2 - width / 2,
        work.x,
        work.right() - width,
    )
}

/// 一组窗口沿 `side` 首尾相接地堆叠，全在 `side` 那一侧的外面。返回各自的 y。
/// 堆叠而不是各贴各的：两个窗口都贴在同一侧必然重叠（ADR：附属窗口不许互相遮挡）。
fn stack(items: &[&Placement], anchor: Rect, gap: i32, side: Side) -> Vec<i32> {
    let mut tops = Vec::with_capacity(items.len());
    match side {
        Side::Below => {
            let mut cursor = anchor.bottom() + gap;
            for item in items {
                tops.push(cursor);
                cursor += item.height + gap;
            }
        }
        Side::Above => {
            // 从锚点往上退：第一个贴着宠物顶，之后每个再往上一个。
            let mut cursor = anchor.y - gap;
            for item in items {
                cursor -= item.height;
                tops.push(cursor);
                cursor -= gap;
            }
        }
    }
    tops
}

/// 整组是否都在工作区内。判定看的是**整条放不放得下**，不是顶边：只看顶边的话，
/// 最后一个窗口的底会悄悄越过屏幕底边。
fn group_fits(tops: &[i32], items: &[&Placement], work: Rect) -> bool {
    tops.iter().zip(items).all(|(top, item)| {
        *top >= work.y && *top + item.height <= work.bottom()
    })
}

/// 兜底：把贴着宠物的那一块推到已落窗口之外，方向由谁更挤得下决定。
///
/// 兜底的职责只有一件：**别压在别人身上**。「在不在工作区」交给调用方最后统一
/// 判断 —— 在这里夹回去的话，宠物贴底那一例会算出 872，正好又压回占着 792–888
/// 的摘要条上（两块叠死，D06 实机第一版）。躲得开比贴得齐更要紧。
fn clamped_tops(
    items: &[&Placement],
    tops: &[i32],
    work: Rect,
    taken: &[Rect],
    anchor: Rect,
) -> Vec<i32> {
    let Some(first) = items.first() else {
        return tops.to_vec();
    };
    let Some(first_top) = tops.first() else {
        return tops.to_vec();
    };
    // 碰撞判断必须用**真实的 x**：所有窗口都居中于宠物，各自有各自的宽度，
    // 用工作区左边缘当占位会得出「不撞」的结论（D06 实机那一版就是这么错的：
    // 拿 x=0 去试 720 高的对话条，与 x=784 的摘要条判成互不相交）。
    let anchor_x = centered_x(anchor, first.width, work);
    let mut placed = *first_top;
    for _ in 0..=taken.len() {
        let hit = taken
            .iter()
            .find(|rect| Rect::new(anchor_x, placed, first.width, first.height).intersects(rect));
        let Some(rect) = hit else { break };
        // 挑「躲得开」的那一边：下面放得下就往下，否则往上。
        let fits_below = rect.bottom() + AVOID_GAP + first.height <= work.bottom();
        placed = if fits_below {
            rect.bottom() + AVOID_GAP
        } else {
            (rect.y - first.height - AVOID_GAP).max(work.y)
        };
    }
    // 后面几个挨着第一个排开，保证同组不重叠。
    let mut out = Vec::with_capacity(items.len());
    let mut cursor = placed;
    for item in items {
        out.push(cursor);
        cursor += item.height + AVOID_GAP;
    }
    out
}

/// 兜底时两块之间留的缝。比 GAP 窄一点：这时已经挑不出更好的位置了，
/// 贴紧一点至少让整组都露出来，而不是把用户刚叫出来的那块挤到屏幕外。
const AVOID_GAP: i32 = 8;

/// 一组窗口在 `side` 那一侧的落点，必要时**越过后方已落的窗口**继续往外推。
///
/// 翻面解决的是「出不出工作区」，解决不了「彼此挡不挡」：宠物贴着屏幕底时，
/// 摘要条与对话条都想往上，翻过去之后两个正好叠在一起（实机 D06 的第一个问题）。
/// 所以落在别人已占的位置上时要继续往外推。
fn place_avoiding(
    group: &[&Placement],
    anchor: Rect,
    work: Rect,
    gap: i32,
    side: Side,
    taken: &[Rect],
) -> Option<Vec<i32>> {
    let mut tops = stack(group, anchor, gap, side);
    // 撞上已落的窗口时，把这一组推到它们**再往外一格**。
    //
    // 判据是「落位之后与谁相撞」，不是「在宠物的上边还是下边」—— 翻面之后
    // 对话条也到了宠物上方，按宠物上下边去筛会把它漏掉，两块就又叠上了
    // （D06 实机第一版就是这么错的）。
    //
    // 两个方向都往「更远离宠物」推，方向由 `side` 决定：Below 往下、Above 往上。
    // 但推不过工作区时也要能横过来，所以推完仍然相撞就返回 None，交给调用方
    // 换一侧重试。
    if taken.iter().any(|rect| hits_any(group, &tops, anchor, work, rect)) {
        // 往「远离已落窗口」的方向挪一格，挪到它们外面为止。量的是**这一组自己
        // 当前的位置**到已落窗口的边，不是相对宠物 —— 翻面之后这一组已经在
        // 宠物上方，拿宠物当基准会算出一个差一截的位移，两块仍然压着
        // （D06 实机第一版：摘要条底 888、对话条顶 872，压了 16px）。
        let pushed: Vec<i32> = match side {
            Side::Below => {
                let floor = taken
                    .iter()
                    .map(|rect| rect.bottom() + gap)
                    .max()
                    .unwrap_or(i32::MIN);
                tops.iter().map(|top| (*top).max(floor)).collect()
            }
            Side::Above => {
                let ceiling = taken
                    .iter()
                    .map(|rect| rect.y - gap)
                    .min()
                    .unwrap_or(i32::MAX);
                tops.iter().map(|top| (*top).min(ceiling)).collect()
            }
        };
        if taken.iter().any(|rect| hits_any(group, &pushed, anchor, work, rect)) {
            return None;
        }
        tops = pushed;
    }
    if !group_fits(&tops, group, work) {
        return None;
    }
    Some(tops)
}

fn hits_any(group: &[&Placement], tops: &[i32], anchor: Rect, work: Rect, other: &Rect) -> bool {
    group.iter().zip(tops).any(|(item, top)| {
        Rect::new(
            centered_x(anchor, item.width, work),
            *top,
            item.width,
            item.height,
        )
        .intersects(other)
    })
}

/// 算出一组附属窗口的位置。
///
/// 先把窗口按各自的 `prefer` 分成上下两组，各自在偏好的一侧堆叠；那一侧放不下
/// 就整体翻到另一侧；翻过去撞上已经落好的窗口就继续往外推；实在放不下才夹进
/// 工作区。同组不重叠靠堆叠保证，上下两组不重叠靠**后落的给先落的让位**保证 ——
/// 互不遮挡不靠事后检测再挪一遍，那样会来回抖。
pub fn arrange(
    anchor: Rect,
    items: &[Placement],
    work: Rect,
    gap: i32,
) -> Vec<Positioned> {
    let above: Vec<&Placement> = items
        .iter()
        .filter(|item| item.prefer == Side::Above)
        .collect();
    let below: Vec<&Placement> = items
        .iter()
        .filter(|item| item.prefer == Side::Below)
        .collect();

    let mut out = Vec::with_capacity(items.len());
    let mut taken: Vec<Rect> = Vec::new();
    for (group, prefer) in [(above, Side::Above), (below, Side::Below)] {
        if group.is_empty() {
            continue;
        }
        // 偏好侧与另一侧都试一遍。兜底用的基准是**翻面后**那一份：宠物贴底时
        // 真正能用的是它，拿偏好侧当基准会把这一组又推回工作区外面去。
        let flipped = stack(&group, anchor, gap, opposite(prefer));
        let tops = [prefer, opposite(prefer)]
            .into_iter()
            .find_map(|side| place_avoiding(&group, anchor, work, gap, side, &taken))
            .unwrap_or_else(|| clamped_tops(&group, &flipped, work, &taken, anchor));
        for (item, top) in group.iter().zip(tops) {
            let x = centered_x(anchor, item.width, work);
            taken.push(Rect::new(x, top, item.width, item.height));
            out.push(Positioned {
                label: item.label,
                x,
                y: top,
            });
        }
    }
    out
}

pub fn opposite(side: Side) -> Side {
    match side {
        Side::Above => Side::Below,
        Side::Below => Side::Above,
    }
}

/// 候选位置里第一个既不压住 `blockers`、又整个在工作区里的。
///
/// 用户自己打开的插件页面是 536×659 的大窗口，停在哪儿由用户说了算。宿主不去动它
/// （那是用户放好的），但新摆出来的窗口得**绕开**它 —— 摘要条压在插件页面上，
/// 插件页面就点不到了。
pub fn first_free(
    candidates: &[Rect],
    blockers: &[Rect],
    work: Rect,
) -> Option<Rect> {
    candidates
        .iter()
        .find(|candidate| {
            work.contains(candidate)
                && !blockers.iter().any(|blocker| blocker.intersects(candidate))
        })
        .copied()
}

/// 围绕宠物铺开的候选位置：先偏好侧，再另一侧，然后是同一侧上移/下移一屏。
///
/// 顺序即优先级 —— 用户把宠物放在某个位置，多半是喜欢那儿，因此**尽量留在宠物
/// 旁边**比「保证不遮挡」更优先；只有在真的放不下时才退到更远的地方。
pub fn candidates_around(anchor: Rect, item: &Placement, work: Rect, gap: i32) -> Vec<Rect> {
    let width = item.width;
    let height = item.height;
    let x = centered_x(anchor, width, work);
    let below = anchor.bottom() + gap;
    let above = anchor.y - height - gap;
    let far_below = below + height + gap;
    let far_above = above - height - gap;
    match item.prefer {
        Side::Below => vec![
            item.at(x, below),
            item.at(x, above),
            item.at(x, far_below),
            item.at(x, far_above),
        ],
        Side::Above => vec![
            item.at(x, above),
            item.at(x, below),
            item.at(x, far_above),
            item.at(x, far_below),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GAP: i32 = 12;
    const BUBBLE: &str = "bubble";
    const SUMMARY: &str = "summary";

    fn work() -> Rect {
        Rect::new(0, 0, 1920, 1040)
    }

    fn pet() -> Rect {
        Rect::new(900, 300, 128, 128)
    }

    fn bubble() -> Placement {
        Placement::new(BUBBLE, 380, 168, Side::Below)
    }

    fn summary() -> Placement {
        Placement::new(SUMMARY, 360, 96, Side::Above)
    }

    /// 按 label 取落位。**不按下标** —— arrange 先排偏好上方的那组，返回顺序
    /// 与传入顺序不是一回事，按下标取的测试会在换实现时悄悄测错东西。
    fn at(items: &[Placement], anchor: Rect, area: Rect, label: &str) -> Rect {
        let position = arrange(anchor, items, area, GAP)
            .into_iter()
            .find(|position| position.label == label)
            .unwrap_or_else(|| panic!("{label} 没有落位"));
        let item = items
            .iter()
            .find(|item| item.label == label)
            .expect("arrange 只回它收过的窗口");
        Rect::new(position.x, position.y, item.width, item.height)
    }

    fn placed(items: &[Placement], anchor: Rect, area: Rect) -> Vec<Rect> {
        arrange(anchor, items, area, GAP)
            .into_iter()
            .map(|position| {
                let item = items
                    .iter()
                    .find(|item| item.label == position.label)
                    .expect("arrange 只回它收过的窗口");
                Rect::new(position.x, position.y, item.width, item.height)
            })
            .collect()
    }

    #[test]
    fn each_window_lands_on_its_own_side_of_the_pet() {
        let items = [bubble(), summary()];
        let above = at(&items, pet(), work(), SUMMARY);
        let below = at(&items, pet(), work(), BUBBLE);
        assert!(above.bottom() <= pet().y, "摘要条整条在宠物上方");
        assert!(below.y >= pet().bottom(), "对话条整条在宠物下方");
    }

    #[test]
    fn no_two_attached_windows_overlap_each_other() {
        // 宠物贴底时两侧都放不下，两边都会翻到上面 —— 那一刻最容易叠在一起。
        // 叠起来两个都点不到，而它们都是用户主动叫出来的（实机 D06 的起点）。
        let low = Rect::new(900, 900, 128, 128);
        let out = placed(&[bubble(), summary()], low, work());
        for (index, left) in out.iter().enumerate() {
            for right in out.iter().skip(index + 1) {
                assert!(
                    !left.intersects(right),
                    "{:?} 与 {:?} 撞了",
                    left,
                    right
                );
            }
        }
    }

    #[test]
    fn the_two_windows_stay_clear_of_each_other_at_every_corner() {
        // 贴着任意一条边都不行：上面、下面、左边、右边各试一遍。D06 的验收标准
        // 是「不互相遮挡」，那是四个角落都要成立的一句话，不是一个位置。
        let area = work();
        for (x, y) in [
            (0, 0),
            (area.right() - 128, 0),
            (0, area.bottom() - 128),
            (area.right() - 128, area.bottom() - 128),
            (900, 300),
            (896, 900),
        ] {
            let anchor = Rect::new(x, y, 128, 128);
            let out = placed(&[bubble(), summary()], anchor, area);
            assert_eq!(out.len(), 2);
            assert!(
                !out[0].intersects(&out[1]),
                "宠物在 ({x}, {y}) 时两块撞了：{:?} 与 {:?}",
                out[0],
                out[1]
            );
        }
    }

    #[test]
    fn a_growing_summary_pushes_the_bubble_out_of_its_way() {
        // 摘要条展开后从 96 高变成 420 高，占的地方大得多。改完高度要整组重排，
        // 否则它会盖住正在输入的对话条 —— 那正是 D06 要修的那件事。
        let items = [bubble(), summary()];
        let collapsed = at(&items, pet(), work(), SUMMARY);
        let grown = at(
            &[bubble(), Placement::new(SUMMARY, 360, 420, Side::Above)],
            pet(),
            work(),
            SUMMARY,
        );
        assert!(grown.height > collapsed.height);
        // 两块仍然不重叠：摘要变高之后，对话条要让开。
        let with_grown = at(
            &[bubble(), Placement::new(SUMMARY, 360, 420, Side::Above)],
            pet(),
            work(),
            BUBBLE,
        );
        assert!(!grown.intersects(&with_grown));
    }

    #[test]
    fn three_windows_on_one_side_stack_head_to_tail() {
        // 同侧的窗口首尾相接，而不是各贴各的 —— 后一个挂在前一个外面。
        let items = vec![
            Placement::new("a", 300, 100, Side::Below),
            Placement::new("b", 300, 200, Side::Below),
            Placement::new("c", 300, 50, Side::Below),
        ];
        let out = arrange(pet(), &items, work(), GAP);
        let tops: Vec<i32> = out.iter().map(|item| item.y).collect();
        assert_eq!(tops, vec![440, 552, 764]);
        for pair in tops.windows(2) {
            assert!(pair[0] < pair[1], "同侧要一个挨一个，不能重叠");
        }
    }

    #[test]
    fn a_group_flips_to_the_other_side_rather_than_leaving_the_screen() {
        let top = Rect::new(900, 8, 128, 128);
        let out = placed(&[summary()], top, work());
        // 上方放不下（8 - 96 - 12 < 0），翻到下面：8 + 128 + 12。
        assert_eq!(out[0].y, 148);
    }

    #[test]
    fn the_whole_band_stays_inside_the_work_area() {
        for anchor_y in [0, 4, 40, 300, 900, 936, 1040 - 128] {
            let anchor = Rect::new(900, anchor_y, 128, 128);
            let out = placed(&[bubble(), summary()], anchor, work());
            for rect in out {
                assert!(
                    work().contains(&rect),
                    "宠物在 y={anchor_y} 时 {:?} 跑出了工作区",
                    rect
                );
            }
        }
    }

    #[test]
    fn a_second_display_at_negative_coordinates_still_holds() {
        // 第二块屏在主屏左边：x 是负的。工作区给的是物理像素，逻辑上的
        // "0 就是最左" 在这里不成立。
        let area = Rect::new(-2560, -200, 2560, 1400);
        let anchor = Rect::new(-2000, 600, 128, 128);
        let out = placed(&[bubble(), summary()], anchor, area);
        for rect in out {
            assert!(area.contains(&rect), "{rect:?} 跑出了第二块屏");
        }
    }

    #[test]
    fn a_high_dpi_window_is_measured_in_physical_pixels() {
        // 150% 的屏上，96 逻辑像素的摘要条是 144 物理像素。用逻辑像素去排，
        // 算出来的位置会比实际小 1.5 倍，窗口会压在宠物上（实机踩过：混用
        // 逻辑与物理，150% 下收起高度判成展开）。
        let area = Rect::new(0, 0, 2880, 1560);
        let anchor = Rect::new(1400, 700, 192, 192);
        let out = placed(
            &[Placement::new(SUMMARY, 540, 144, Side::Above)],
            anchor,
            area,
        );
        assert!(out[0].bottom() <= anchor.y);
        assert!(area.contains(&out[0]));
    }

    #[test]
    fn a_work_area_shorter_than_the_band_keeps_the_band_at_the_top() {
        // 两边都放不下：宁可整组略微出界，也不要散到屏幕另一头。
        let area = Rect::new(0, 0, 1920, 200);
        let anchor = Rect::new(900, 30, 128, 128);
        let out = placed(&[bubble(), summary()], anchor, area);
        assert!(out[0].y >= area.y, "至少第一块还在工作区里");
    }

    #[test]
    fn a_window_avoids_a_plugin_page_the_user_placed_there() {
        // 插件页面是用户自己放的，宿主不去动它；但摘要条压上去它就点不到了。
        let anchor = pet();
        let item = summary();
        let page = Rect::new(900, 300 - 96 - GAP, 360, 96);
        let avoid = first_free(
            &candidates_around(anchor, &item, work(), GAP),
            &[page],
            work(),
        );
        assert!(avoid.is_some());
        assert!(!avoid.expect("应当挪得开").intersects(&page));
    }

    #[test]
    fn a_window_keeps_its_preferred_spot_when_it_is_free() {
        // 用户把宠物放在那儿，多半是喜欢那儿。空着的时候别乱动。
        let anchor = pet();
        let item = summary();
        let free = first_free(
            &candidates_around(anchor, &item, work(), GAP),
            &[],
            work(),
        );
        assert_eq!(free, Some(Rect::new(784, 192, 360, 96)));
    }

    #[test]
    fn a_window_stays_put_when_every_candidate_is_taken() {
        // 全被占了就不挪。挪到一个看得见的地方，比原地不动更糟吗？一样糟 ——
        // 但「不动」至少让用户知道它原来在哪儿。
        let anchor = pet();
        let item = summary();
        let all = candidates_around(anchor, &item, work(), GAP);
        let blockers: Vec<Rect> = all.clone();
        assert_eq!(first_free(&all, &blockers, work()), None);
    }

    #[test]
    fn clamping_survives_a_work_area_smaller_than_the_window() {
        // 极小屏或极端分屏：max < min 时夹回 min，而不是算出负数或溢出。
        let tiny = Rect::new(0, 0, 100, 60);
        let item = Placement::new(BUBBLE, 380, 168, Side::Below);
        let out = arrange(pet(), &[item], tiny, GAP);
        assert!(out[0].x >= tiny.x && out[0].y >= tiny.y);
    }
}
