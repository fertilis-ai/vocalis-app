use crate::engines::cosine_similarity;

// Speaker-labeling pieces shared by the live session pipeline (`live_session`)
// and the file-import pipeline (`import`). Pure, unit-tested: cluster indices →
// display letters, first-appearance renumbering, and enrolled-Person matching.

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
