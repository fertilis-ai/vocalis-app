use std::collections::HashMap;

use serde::Deserialize;

use crate::engines::cosine_similarity;

// Speaker-labeling pieces shared by the live session pipeline (`live_session`)
// and the file-import pipeline (`import`). Pure, unit-tested: cluster indices →
// display letters, first-appearance renumbering, and enrolled-Person matching.

/// A prior transcript segment's label + span, sent from the webview when
/// `session_pipeline_start` is resuming a session that already has recorded
/// content (empty for a fresh session). Wire shape doubles as the internal
/// shape — unlike `EnrolledPersonRef`, there's no fallible disk load between
/// the two, so no separate conversion type is needed.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSegment {
    pub speaker_label: String,
    pub start_ms: f64,
    pub end_ms: f64,
}

/// One enrolled Person's averaged embedding, for online + refinement matching.
#[derive(Clone)]
pub struct EnrolledSpeaker {
    pub person_id: String,
    pub embedding: Vec<f32>,
}

/// "A", "B", … "Z", "AA", "AB", … — matches `src/lib/speaker-labels.ts`.
pub fn letter_label(index: usize) -> String {
    let mut name = String::new();
    let mut i = index as i64;
    loop {
        name.insert(0, (b'A' + (i % 26) as u8) as char);
        i = i / 26 - 1;
        if i < 0 {
            break;
        }
    }
    name
}

/// Add `emb` into a running sum (initializing it if empty).
pub fn accumulate(sum: &mut Vec<f32>, emb: &[f32]) {
    if sum.is_empty() {
        sum.extend_from_slice(emb);
    } else {
        for (s, e) in sum.iter_mut().zip(emb.iter()) {
            *s += e;
        }
    }
}

/// Compress arbitrary speaker ids into contiguous cluster indices numbered by
/// first appearance (so the first speaker seen is always "A").
pub fn relabel_by_first_appearance(speakers: &[i32]) -> Vec<usize> {
    let mut order: Vec<i32> = Vec::new();
    speakers
        .iter()
        .map(|&s| match order.iter().position(|&o| o == s) {
            Some(i) => i,
            None => {
                order.push(s);
                order.len() - 1
            }
        })
        .collect()
}

/// Like `relabel_by_first_appearance`, but continuing a prior run's speaker
/// lettering across a resume instead of renumbering from scratch. `resume_diar_ids`
/// and `new_diar_ids` are this stop's diarization ids for the prior segments'
/// spans and the new run's spans respectively (both produced by
/// `refine_speakers` against the same, current diarization pass — valid since
/// a resumed capture's buffer still holds the old audio at its original
/// offsets). Reconciliation: each prior speaker label gets a cluster index by
/// first appearance in `resume_segments`; each diarization id is mapped to
/// whichever of those clusters it most overlaps (majority vote across the
/// prior spans it was assigned to); a new-run diarization id with no such
/// vote gets the next unused index, in first-appearance order among the new
/// spans. With empty `resume_segments` this degenerates to exactly
/// `relabel_by_first_appearance(new_diar_ids)` — a strict generalization, not
/// a resume-only branch.
pub fn relabel_continuing_from_resume(
    resume_segments: &[ResumeSegment],
    resume_diar_ids: &[i32],
    new_diar_ids: &[i32],
) -> Vec<usize> {
    let mut labels: Vec<&str> = Vec::new();
    for seg in resume_segments {
        if !labels.contains(&seg.speaker_label.as_str()) {
            labels.push(&seg.speaker_label);
        }
    }

    let mut votes: HashMap<i32, HashMap<usize, usize>> = HashMap::new();
    for (seg, &diar_id) in resume_segments.iter().zip(resume_diar_ids) {
        let cluster = labels
            .iter()
            .position(|&l| l == seg.speaker_label)
            .expect("label was just collected from these same segments");
        *votes.entry(diar_id).or_default().entry(cluster).or_insert(0) += 1;
    }
    let diar_to_cluster: HashMap<i32, usize> = votes
        .into_iter()
        .map(|(id, counts)| {
            let cluster = *counts.iter().max_by_key(|entry| *entry.1).unwrap().0;
            (id, cluster)
        })
        .collect();

    let mut next = labels.len();
    let mut seen: HashMap<i32, usize> = HashMap::new();
    new_diar_ids
        .iter()
        .map(|&id| {
            if let Some(&c) = diar_to_cluster.get(&id) {
                c
            } else if let Some(&c) = seen.get(&id) {
                c
            } else {
                let c = next;
                next += 1;
                seen.insert(id, c);
                c
            }
        })
        .collect()
}

/// Nearest enrolled person to `emb` above `threshold`, if any.
pub fn match_person(enrolled: &[EnrolledSpeaker], emb: &[f32], threshold: f32) -> Option<String> {
    let mut best: Option<&str> = None;
    let mut best_sim = threshold;
    for person in enrolled {
        let sim = cosine_similarity(&person.embedding, emb);
        if sim >= best_sim {
            best_sim = sim;
            best = Some(&person.person_id);
        }
    }
    best.map(|s| s.to_string())
}

/// For each cluster index, the enrolled person its mean embedding matches (or
/// None). `clusters[i]` is item i's cluster; `embeddings[i]` is item i's
/// embedding (None when extraction failed). Shared by the live refinement pass
/// and the import run to settle a per-cluster identity from all its segments.
pub fn cluster_means_to_people(
    clusters: &[usize],
    embeddings: &[Option<Vec<f32>>],
    enrolled: &[EnrolledSpeaker],
    threshold: f32,
) -> Vec<Option<String>> {
    let n = clusters.iter().copied().max().map_or(0, |m| m + 1);
    let mut sums: Vec<Vec<f32>> = vec![Vec::new(); n];
    let mut counts: Vec<usize> = vec![0; n];
    for (cluster, emb) in clusters.iter().zip(embeddings.iter()) {
        if let Some(emb) = emb {
            accumulate(&mut sums[*cluster], emb);
            counts[*cluster] += 1;
        }
    }
    (0..n)
        .map(|c| {
            if counts[c] == 0 {
                return None;
            }
            let mean: Vec<f32> = sums[c].iter().map(|v| v / counts[c] as f32).collect();
            match_person(enrolled, &mean, threshold)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letter_labels_match_ts_naming() {
        assert_eq!(letter_label(0), "A");
        assert_eq!(letter_label(25), "Z");
        assert_eq!(letter_label(26), "AA");
        assert_eq!(letter_label(27), "AB");
    }

    #[test]
    fn relabel_numbers_by_first_appearance() {
        assert_eq!(relabel_by_first_appearance(&[7, 7, 3, 7, 3]), vec![0, 0, 1, 0, 1]);
        assert_eq!(relabel_by_first_appearance(&[]), Vec::<usize>::new());
    }

    fn resume_seg(label: &str, start_ms: f64, end_ms: f64) -> ResumeSegment {
        ResumeSegment { speaker_label: label.into(), start_ms, end_ms }
    }

    #[test]
    fn relabel_continuing_from_resume_with_no_history_matches_first_appearance() {
        let new_ids = [7, 7, 3, 7, 3];
        assert_eq!(
            relabel_continuing_from_resume(&[], &[], &new_ids),
            relabel_by_first_appearance(&new_ids),
        );
    }

    #[test]
    fn relabel_continuing_from_resume_reuses_matched_label() {
        // Prior run: "A" was diarization id 7, "B" was id 3.
        let resume_segments = vec![resume_seg("A", 0.0, 1000.0), resume_seg("B", 1000.0, 2000.0)];
        let resume_diar_ids = [7, 3];
        // New run: the same two diarization ids reappear, "B" first.
        let new_diar_ids = [3, 3, 7];
        assert_eq!(
            relabel_continuing_from_resume(&resume_segments, &resume_diar_ids, &new_diar_ids),
            vec![1, 1, 0],
        );
    }

    #[test]
    fn relabel_continuing_from_resume_assigns_next_index_to_a_new_speaker() {
        let resume_segments = vec![resume_seg("A", 0.0, 1000.0)];
        let resume_diar_ids = [7];
        // diar id 9 never appeared in the resume history — a genuinely new speaker.
        let new_diar_ids = [7, 9, 9];
        assert_eq!(
            relabel_continuing_from_resume(&resume_segments, &resume_diar_ids, &new_diar_ids),
            vec![0, 1, 1],
        );
    }

    #[test]
    fn relabel_continuing_from_resume_majority_vote_resolves_conflicting_diar_ids() {
        // Diarization id 7 is associated with "A" twice and "B" once (e.g. a
        // brief mislabeled span) — the majority (A) should win the mapping.
        let resume_segments = vec![
            resume_seg("A", 0.0, 1000.0),
            resume_seg("A", 1000.0, 2000.0),
            resume_seg("B", 2000.0, 3000.0),
        ];
        let resume_diar_ids = [7, 7, 7];
        let new_diar_ids = [7];
        assert_eq!(
            relabel_continuing_from_resume(&resume_segments, &resume_diar_ids, &new_diar_ids),
            vec![0],
        );
    }

    #[test]
    fn match_person_picks_nearest_above_threshold() {
        let enrolled = vec![
            EnrolledSpeaker { person_id: "a".into(), embedding: vec![1.0, 0.0, 0.0] },
            EnrolledSpeaker { person_id: "b".into(), embedding: vec![0.0, 1.0, 0.0] },
        ];
        assert_eq!(match_person(&enrolled, &[0.95, 0.05, 0.0], 0.8).as_deref(), Some("a"));
        assert_eq!(match_person(&enrolled, &[0.6, 0.6, 0.0], 0.8), None);
    }

    #[test]
    fn cluster_means_average_before_matching() {
        let enrolled = vec![EnrolledSpeaker {
            person_id: "martin".into(),
            embedding: vec![1.0, 0.0],
        }];
        // Cluster 0's two segments average to (0.95, 0.05) → matches; cluster 1
        // has no usable embedding → None.
        let clusters = vec![0, 0, 1];
        let embeddings = vec![
            Some(vec![1.0, 0.0]),
            Some(vec![0.9, 0.1]),
            None,
        ];
        let people = cluster_means_to_people(&clusters, &embeddings, &enrolled, 0.9);
        assert_eq!(people[0].as_deref(), Some("martin"));
        assert_eq!(people[1], None);
    }
}
