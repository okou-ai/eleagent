# Eleagent

**An elephant's memory. An agent's mind.**

A self-hosted personal memory system. Capture audio and video in a browser, retain the original evidence, organize observations into a graph, and consolidate the day into memories and a diary during a scheduled sleep cycle.

Eleagent is an experimental reference implementation. Its initial hardware profile uses two NVIDIA DGX Spark systems: daytime perception shares the GPUs with a larger model at night.

![Eleagent architecture: daytime parallel video perception and nighttime Pi memory consolidation, with model allocation on DGX Spark 1 and 2](docs/images/architecture.png)

## Capture

The web application and upload endpoint share an origin:

- `GET /` serves the capture interface.
- `POST /` accepts a multipart `meta` JSON field and a `video` file, authenticated with a bearer token.
- Successful responses acknowledge durable archival. Repeating the same capture ID, sequence and content is idempotent.

The browser records separate short clips and uploads them in order. Keep the page in the foreground. Screen Wake Lock requests an awake display; it cannot prevent a deliberate lock or guarantee background recording. Interrupted capture is shown explicitly. Use HTTPS on phones. iOS 18.4 or later is recommended for home-screen use.

To deploy, follow the [agent deployment runbook](docs/agent-runbook.md).

## Repository

| Path | Responsibility |
| --- | --- |
| `apps/web` | Browser capture and bounded local upload queue |
| `services/observer` | Upload ingress and MiniCPM observation scheduling |
| `services/archive` | Original media and timestamped evidence |
| `services/recognition` | Face, object, speech and OCR workers |
| `services/graph-api` | Read API for the memory graph |
| `services/graph-sync` | Incremental graph synchronization |
| `services/sleep` | Pi memory tools, prompts and nightly consolidation |
| `runtime/gpu-manager` | Host GPU leases, draining and recovery |
| `deploy` | Versioned model and hardware recipes |

The local model route has a configured 524,288-token context window.

## Licensing

Original project code is AGPL-3.0-only unless a file states otherwise. Dependencies retain their own licenses. Model weights are obtained separately and are not covered by this repository's license.

**The DFlash2 draft weights in the experimental accelerated recipe use CC BY-NC-ND 4.0.** This recipe is not an unrestricted commercial model stack. Downloading weights yourself does not remove their license conditions. The pinned MiniCPM demo application also lacks an explicit source license; resolve its redistribution terms separately. See [third-party notices](THIRD_PARTY_NOTICES.md) and the model manifest before choosing a deployment.

## References

These works were consulted during Eleagent's design discussions, including conceptual foundations and alternatives explored but not implemented. Inclusion does not imply implementation of a cited method, validation of Eleagent, or biological equivalence.

### Memory foundations, replay, and consolidation

[1] T. J. Teyler and P. DiScenna, “The hippocampal memory indexing theory,” *Behavioral Neuroscience*, vol. 100, no. 2, pp. 147–154, 1986, doi: [10.1037/0735-7044.100.2.147](https://doi.org/10.1037/0735-7044.100.2.147).

[2] T. J. Teyler and J. W. Rudy, “The hippocampal indexing theory and episodic memory: Updating the index,” *Hippocampus*, vol. 17, no. 12, pp. 1158–1169, 2007, doi: [10.1002/hipo.20350](https://doi.org/10.1002/hipo.20350).

[3] J. L. McClelland, B. L. McNaughton, and R. C. O'Reilly, “Why there are complementary learning systems in the hippocampus and neocortex: Insights from the successes and failures of connectionist models of learning and memory,” *Psychological Review*, vol. 102, no. 3, pp. 419–457, 1995, doi: [10.1037/0033-295X.102.3.419](https://doi.org/10.1037/0033-295X.102.3.419).

[4] D. Kumaran, D. Hassabis, and J. L. McClelland, “What learning systems do intelligent agents need? Complementary learning systems theory updated,” *Trends in Cognitive Sciences*, vol. 20, no. 7, pp. 512–534, 2016, doi: [10.1016/j.tics.2016.05.004](https://doi.org/10.1016/j.tics.2016.05.004).

[5] M. A. Wilson and B. L. McNaughton, “Reactivation of hippocampal ensemble memories during sleep,” *Science*, vol. 265, no. 5172, pp. 676–679, 1994, doi: [10.1126/science.8036517](https://doi.org/10.1126/science.8036517).

[6] G. Buzsáki, “Hippocampal sharp wave-ripple: A cognitive biomarker for episodic memory and planning,” *Hippocampus*, vol. 25, no. 10, pp. 1073–1188, 2015, doi: [10.1002/hipo.22488](https://doi.org/10.1002/hipo.22488).

[7] G. Tononi and C. Cirelli, “Sleep function and synaptic homeostasis,” *Sleep Medicine Reviews*, vol. 10, no. 1, pp. 49–62, 2006, doi: [10.1016/j.smrv.2005.05.002](https://doi.org/10.1016/j.smrv.2005.05.002).

[8] G. Tononi and C. Cirelli, “Sleep and the price of plasticity: From synaptic and cellular homeostasis to memory consolidation and integration,” *Neuron*, vol. 81, no. 1, pp. 12–34, 2014, doi: [10.1016/j.neuron.2013.12.025](https://doi.org/10.1016/j.neuron.2013.12.025).

[9] U. Frey and R. G. M. Morris, “Synaptic tagging and long-term potentiation,” *Nature*, vol. 385, no. 6616, pp. 533–536, 1997, doi: [10.1038/385533a0](https://doi.org/10.1038/385533a0).

[10] D. Tse *et al.*, “Schemas and memory consolidation,” *Science*, vol. 316, no. 5821, pp. 76–82, 2007, doi: [10.1126/science.1135935](https://doi.org/10.1126/science.1135935).

[11] I. Wilhelm, S. Diekelmann, I. Molzow, A. Ayoub, M. Mölle, and J. Born, “Sleep selectively enhances memory expected to be of future relevance,” *The Journal of Neuroscience*, vol. 31, no. 5, pp. 1563–1569, 2011, doi: [10.1523/JNEUROSCI.3575-10.2011](https://doi.org/10.1523/JNEUROSCI.3575-10.2011).

[12] J. M. Zacks, N. K. Speer, K. M. Swallow, T. S. Braver, and J. R. Reynolds, “Event perception: A mind-brain perspective,” *Psychological Bulletin*, vol. 133, no. 2, pp. 273–293, 2007, doi: [10.1037/0033-2909.133.2.273](https://doi.org/10.1037/0033-2909.133.2.273).

[13] M. A. Yassa and C. E. L. Stark, “Pattern separation in the hippocampus,” *Trends in Neurosciences*, vol. 34, no. 10, pp. 515–525, 2011, doi: [10.1016/j.tins.2011.06.006](https://doi.org/10.1016/j.tins.2011.06.006).

[14] J. R. Anderson and L. J. Schooler, “Reflections of the environment in memory,” *Psychological Science*, vol. 2, no. 6, pp. 396–408, 1991, doi: [10.1111/j.1467-9280.1991.tb00174.x](https://doi.org/10.1111/j.1467-9280.1991.tb00174.x).

[15] K. Nader, G. E. Schafe, and J. E. Le Doux, “Fear memories require protein synthesis in the amygdala for reconsolidation after retrieval,” *Nature*, vol. 406, no. 6797, pp. 722–726, 2000, doi: [10.1038/35021052](https://doi.org/10.1038/35021052).

[16] C. J. Brainerd and V. F. Reyna, “Fuzzy-trace theory and false memory,” *Current Directions in Psychological Science*, vol. 11, no. 5, pp. 164–169, 2002, doi: [10.1111/1467-8721.00192](https://doi.org/10.1111/1467-8721.00192).

[17] G. Winocur and M. Moscovitch, “Memory transformation and systems consolidation,” *Journal of the International Neuropsychological Society*, vol. 17, no. 5, pp. 766–780, 2011, doi: [10.1017/S1355617711000683](https://doi.org/10.1017/S1355617711000683).

[18] P. A. Lewis and S. J. Durrant, “Overlapping memory replay during sleep builds cognitive schemata,” *Trends in Cognitive Sciences*, vol. 15, no. 8, pp. 343–351, 2011, doi: [10.1016/j.tics.2011.06.004](https://doi.org/10.1016/j.tics.2011.06.004).

[19] B. A. Richards and P. W. Frankland, “The persistence and transience of memory,” *Neuron*, vol. 94, no. 6, pp. 1071–1084, 2017, doi: [10.1016/j.neuron.2017.04.037](https://doi.org/10.1016/j.neuron.2017.04.037).

### Attention, perception, and sensory organization

[20] E. K. Miller and J. D. Cohen, “An integrative theory of prefrontal cortex function,” *Annual Review of Neuroscience*, vol. 24, pp. 167–202, 2001, doi: [10.1146/annurev.neuro.24.1.167](https://doi.org/10.1146/annurev.neuro.24.1.167).

[21] M. Corbetta and G. L. Shulman, “Control of goal-directed and stimulus-driven attention in the brain,” *Nature Reviews Neuroscience*, vol. 3, no. 3, pp. 201–215, 2002, doi: [10.1038/nrn755](https://doi.org/10.1038/nrn755).

[22] M. A. Goodale and G. K. Humphrey, “The objects of action and perception,” *Cognition*, vol. 67, nos. 1–2, pp. 181–207, 1998, doi: [10.1016/S0010-0277(98)00017-1](https://doi.org/10.1016/S0010-0277(98)00017-1).

[23] P. Lennie, “The cost of cortical computation,” *Current Biology*, vol. 13, no. 6, pp. 493–497, 2003, doi: [10.1016/S0960-9822(03)00135-0](https://doi.org/10.1016/S0960-9822(03)00135-0).

[24] L. Itti and P. Baldi, “Bayesian surprise attracts human attention,” *Vision Research*, vol. 49, no. 10, pp. 1295–1306, 2009, doi: [10.1016/j.visres.2008.09.007](https://doi.org/10.1016/j.visres.2008.09.007).

[25] S. C.-H. Yang, M. Lengyel, and D. M. Wolpert, “Active sensing in the categorization of visual patterns,” *eLife*, vol. 5, Art. no. e12215, 2016, doi: [10.7554/eLife.12215](https://doi.org/10.7554/eLife.12215).

[26] M. F. Land and M. Hayhoe, “In what ways do eye movements contribute to everyday activities?,” *Vision Research*, vol. 41, nos. 25–26, pp. 3559–3565, 2001, doi: [10.1016/S0042-6989(01)00102-X](https://doi.org/10.1016/S0042-6989(01)00102-X).

[27] B. W. Tatler, M. M. Hayhoe, M. F. Land, and D. H. Ballard, “Eye guidance in natural vision: Reinterpreting salience,” *Journal of Vision*, vol. 11, no. 5, Art. no. 5, pp. 1–23, 2011, doi: [10.1167/11.5.5](https://doi.org/10.1167/11.5.5).

[28] Y. Li, A. Fathi, and J. M. Rehg, “Learning to predict gaze in egocentric video,” in *Proc. 2013 IEEE International Conference on Computer Vision*, 2013, pp. 3216–3223, doi: [10.1109/ICCV.2013.399](https://doi.org/10.1109/ICCV.2013.399).

[29] T. Foulsham, E. Walker, and A. Kingstone, “The where, what and when of gaze allocation in the lab and the natural environment,” *Vision Research*, vol. 51, no. 17, pp. 1920–1931, 2011, doi: [10.1016/j.visres.2011.07.002](https://doi.org/10.1016/j.visres.2011.07.002).

[30] E. Pöppel, “A hierarchical model of temporal perception,” *Trends in Cognitive Sciences*, vol. 1, no. 2, pp. 56–61, 1997, doi: [10.1016/S1364-6613(97)01008-5](https://doi.org/10.1016/S1364-6613(97)01008-5).

[31] A. S. Bregman, *Auditory Scene Analysis: The Perceptual Organization of Sound*. MIT Press, 1990, doi: [10.7551/mitpress/1486.001.0001](https://doi.org/10.7551/mitpress/1486.001.0001).

[32] A. Oliva and A. Torralba, “Building the gist of a scene: The role of global image features in recognition,” in *Progress in Brain Research*, vol. 155, 2006, pp. 23–36, doi: [10.1016/S0079-6123(06)55002-2](https://doi.org/10.1016/S0079-6123(06)55002-2).

[33] R. P. N. Rao and D. H. Ballard, “Predictive coding in the visual cortex: A functional interpretation of some extra-classical receptive-field effects,” *Nature Neuroscience*, vol. 2, no. 1, pp. 79–87, 1999, doi: [10.1038/4580](https://doi.org/10.1038/4580).

[34] C. Summerfield and F. P. de Lange, “Expectation in perceptual decision making: Neural and computational mechanisms,” *Nature Reviews Neuroscience*, vol. 15, no. 11, pp. 745–756, 2014, doi: [10.1038/nrn3838](https://doi.org/10.1038/nrn3838).

[35] S.-J. Blakemore, D. M. Wolpert, and C. D. Frith, “Central cancellation of self-produced tickle sensation,” *Nature Neuroscience*, vol. 1, no. 7, pp. 635–640, 1998, doi: [10.1038/2870](https://doi.org/10.1038/2870).

[36] R. Epstein and N. Kanwisher, “A cortical representation of the local visual environment,” *Nature*, vol. 392, no. 6676, pp. 598–601, 1998, doi: [10.1038/33402](https://doi.org/10.1038/33402).

[37] R. Näätänen, P. Paavilainen, T. Rinne, and K. Alho, “The mismatch negativity (MMN) in basic research of central auditory processing: A review,” *Clinical Neurophysiology*, vol. 118, no. 12, pp. 2544–2590, 2007, doi: [10.1016/j.clinph.2007.04.026](https://doi.org/10.1016/j.clinph.2007.04.026).

[38] V. Bruce and A. Young, “Understanding face recognition,” *British Journal of Psychology*, vol. 77, no. 3, pp. 305–327, 1986, doi: [10.1111/j.2044-8295.1986.tb02199.x](https://doi.org/10.1111/j.2044-8295.1986.tb02199.x).

[39] P. Belin, S. Fecteau, and C. Bédard, “Thinking the voice: Neural correlates of voice perception,” *Trends in Cognitive Sciences*, vol. 8, no. 3, pp. 129–135, 2004, doi: [10.1016/j.tics.2004.01.008](https://doi.org/10.1016/j.tics.2004.01.008).

[40] G. Sperling, “The information available in brief visual presentations,” *Psychological Monographs: General and Applied*, vol. 74, no. 11, pp. 1–29, 1960, doi: [10.1037/h0093759](https://doi.org/10.1037/h0093759).

### Event structure, working memory, and memory reliability

[41] W. B. Scoville and B. Milner, “Loss of recent memory after bilateral hippocampal lesions,” *Journal of Neurology, Neurosurgery & Psychiatry*, vol. 20, no. 1, pp. 11–21, 1957, doi: [10.1136/jnnp.20.1.11](https://doi.org/10.1136/jnnp.20.1.11).

[42] B. Rasch, C. Büchel, S. Gais, and J. Born, “Odor cues during slow-wave sleep prompt declarative memory consolidation,” *Science*, vol. 315, no. 5817, pp. 1426–1429, 2007, doi: [10.1126/science.1138581](https://doi.org/10.1126/science.1138581).

[43] R. C. O’Reilly and M. J. Frank, “Making working memory work: A computational model of learning in the prefrontal cortex and basal ganglia,” *Neural Computation*, vol. 18, no. 2, pp. 283–328, 2006, doi: [10.1162/089976606775093909](https://doi.org/10.1162/089976606775093909).

[44] U. Hasson, E. Yang, I. Vallines, D. J. Heeger, and N. Rubin, “A hierarchy of temporal receptive windows in human cortex,” *The Journal of Neuroscience*, vol. 28, no. 10, pp. 2539–2550, 2008, doi: [10.1523/JNEUROSCI.5487-07.2008](https://doi.org/10.1523/JNEUROSCI.5487-07.2008).

[45] C. Baldassano, J. Chen, A. Zadbood, J. W. Pillow, U. Hasson, and K. A. Norman, “Discovering event structure in continuous narrative perception and memory,” *Neuron*, vol. 95, no. 3, pp. 709–721.e5, 2017, doi: [10.1016/j.neuron.2017.06.041](https://doi.org/10.1016/j.neuron.2017.06.041).

[46] N. Cowan, “The magical number 4 in short-term memory: A reconsideration of mental storage capacity,” *Behavioral and Brain Sciences*, vol. 24, no. 1, pp. 87–114, 2001, doi: [10.1017/S0140525X01003922](https://doi.org/10.1017/S0140525X01003922).

[47] M. G. Mattar and N. D. Daw, “Prioritized memory access explains planning and hippocampal replay,” *Nature Neuroscience*, vol. 21, no. 11, pp. 1609–1617, 2018, doi: [10.1038/s41593-018-0232-z](https://doi.org/10.1038/s41593-018-0232-z).

[48] A. C. Schapiro, E. A. McDevitt, T. T. Rogers, S. C. Mednick, and K. A. Norman, “Human hippocampal replay during rest prioritizes weakly learned information and predicts memory performance,” *Nature Communications*, vol. 9, no. 1, Art. no. 3920, 2018, doi: [10.1038/s41467-018-06213-1](https://doi.org/10.1038/s41467-018-06213-1).

[49] A. Baddeley, “The episodic buffer: A new component of working memory?,” *Trends in Cognitive Sciences*, vol. 4, no. 11, pp. 417–423, 2000, doi: [10.1016/S1364-6613(00)01538-2](https://doi.org/10.1016/S1364-6613(00)01538-2).

[50] A. P. Yonelinas, “The nature of recollection and familiarity: A review of 30 years of research,” *Journal of Memory and Language*, vol. 46, no. 3, pp. 441–517, 2002, doi: [10.1006/jmla.2002.2864](https://doi.org/10.1006/jmla.2002.2864).

[51] J. R. Reynolds, J. M. Zacks, and T. S. Braver, “A computational model of event segmentation from perceptual prediction,” *Cognitive Science*, vol. 31, no. 4, pp. 613–643, 2007, doi: [10.1080/15326900701399913](https://doi.org/10.1080/15326900701399913).

[52] M. K. Johnson, S. Hashtroudi, and D. S. Lindsay, “Source monitoring,” *Psychological Bulletin*, vol. 114, no. 1, pp. 3–28, 1993, doi: [10.1037/0033-2909.114.1.3](https://doi.org/10.1037/0033-2909.114.1.3).

[53] H. L. Roediger and K. B. McDermott, “Creating false memories: Remembering words not presented in lists,” *Journal of Experimental Psychology: Learning, Memory, and Cognition*, vol. 21, no. 4, pp. 803–814, 1995, doi: [10.1037/0278-7393.21.4.803](https://doi.org/10.1037/0278-7393.21.4.803).

[54] E. F. Loftus, “Planting misinformation in the human mind: A 30-year investigation of the malleability of memory,” *Learning & Memory*, vol. 12, no. 4, pp. 361–366, 2005, doi: [10.1101/lm.94705](https://doi.org/10.1101/lm.94705).

[55] J. L. McGaugh, “The amygdala modulates the consolidation of memories of emotionally arousing experiences,” *Annual Review of Neuroscience*, vol. 27, pp. 1–28, 2004, doi: [10.1146/annurev.neuro.27.070203.144157](https://doi.org/10.1146/annurev.neuro.27.070203.144157).

[56] K. M. Swallow, J. M. Zacks, and R. A. Abrams, “Event boundaries in perception affect memory encoding and updating,” *Journal of Experimental Psychology: General*, vol. 138, no. 2, pp. 236–257, 2009, doi: [10.1037/a0015631](https://doi.org/10.1037/a0015631).

[57] A. Ben-Yakov and R. N. Henson, “The hippocampal film editor: Sensitivity and specificity to event boundaries in continuous experience,” *The Journal of Neuroscience*, vol. 38, no. 47, pp. 10057–10068, 2018, doi: [10.1523/JNEUROSCI.0524-18.2018](https://doi.org/10.1523/JNEUROSCI.0524-18.2018).

[58] J. E. Lisman and A. A. Grace, “The hippocampal-VTA loop: Controlling the entry of information into long-term memory,” *Neuron*, vol. 46, no. 5, pp. 703–713, 2005, doi: [10.1016/j.neuron.2005.05.002](https://doi.org/10.1016/j.neuron.2005.05.002).

[59] S. M. Smith and E. Vela, “Environmental context-dependent memory: A review and meta-analysis,” *Psychonomic Bulletin & Review*, vol. 8, no. 2, pp. 203–220, 2001, doi: [10.3758/BF03196157](https://doi.org/10.3758/BF03196157).

[60] D. R. Godden and A. D. Baddeley, “Context-dependent memory in two natural environments: On land and underwater,” *British Journal of Psychology*, vol. 66, no. 3, pp. 325–331, 1975, doi: [10.1111/j.2044-8295.1975.tb01468.x](https://doi.org/10.1111/j.2044-8295.1975.tb01468.x).

[61] E. K. Vogel, A. W. McCollough, and M. G. Machizawa, “Neural measures reveal individual differences in controlling access to working memory,” *Nature*, vol. 438, no. 7067, pp. 500–503, 2005, doi: [10.1038/nature04171](https://doi.org/10.1038/nature04171).

[62] A. Goujon, F. Mathy, and S. Thorpe, “The fate of visual long term memories for images across weeks in adults and children,” *Scientific Reports*, vol. 12, no. 1, Art. no. 21763, 2022, doi: [10.1038/s41598-022-26002-7](https://doi.org/10.1038/s41598-022-26002-7).

[63] F. Hutmacher and C. Kuhbandner, “Does the attentional boost effect depend on the intentionality of encoding? Investigating the mechanisms underlying memory for visual objects presented at behaviorally relevant moments in time,” *Frontiers in Psychology*, vol. 11, Art. no. 584187, 2020, doi: [10.3389/fpsyg.2020.584187](https://doi.org/10.3389/fpsyg.2020.584187).

### Graph learning and language-agent memory

[64] B. Fritzke, “A growing neural gas network learns topologies,” in *Advances in Neural Information Processing Systems 7*, G. Tesauro, D. S. Touretzky, and T. K. Leen, Eds. Cambridge, MA, USA: MIT Press, 1995, pp. 625–632. [Online]. Available: https://proceedings.neurips.cc/paper_files/paper/1994/file/d56b9fc4b0f1be8871f5e1c40c0067e7-Paper.pdf.

[65] S. Navlakha, R. Rastogi, and N. Shrivastava, “Graph summarization with bounded error,” in *Proceedings of the 2008 ACM SIGMOD International Conference on Management of Data*, 2008, pp. 419–432, doi: [10.1145/1376616.1376661](https://doi.org/10.1145/1376616.1376661).

[66] V. D. Blondel, J.-L. Guillaume, R. Lambiotte, and E. Lefebvre, “Fast unfolding of communities in large networks,” *Journal of Statistical Mechanics: Theory and Experiment*, vol. 2008, no. 10, Art. no. P10008, 2008, doi: [10.1088/1742-5468/2008/10/P10008](https://doi.org/10.1088/1742-5468/2008/10/P10008). Also available: https://arxiv.org/abs/0803.0476.

[67] B. J. Gutiérrez, Y. Shu, Y. Gu, M. Yasunaga, and Y. Su, “HippoRAG: Neurobiologically inspired long-term memory for large language models,” in *Advances in Neural Information Processing Systems*, vol. 37, 2024, pp. 59532–59569, doi: [10.48550/arXiv.2405.14831](https://doi.org/10.48550/arXiv.2405.14831) (arXiv version).

[68] B. J. Gutiérrez, Y. Shu, W. Qi, S. Zhou, and Y. Su, “From RAG to memory: Non-parametric continual learning for large language models,” in *Proceedings of the 42nd International Conference on Machine Learning*, ser. Proceedings of Machine Learning Research, vol. 267, 2025, pp. 21497–21515. [Online]. Available: https://proceedings.mlr.press/v267/gutierrez25a.html. Also available: https://arxiv.org/abs/2502.14802.

[69] J. S. Park, J. O'Brien, C. J. Cai, M. R. Morris, P. Liang, and M. S. Bernstein, “Generative agents: Interactive simulacra of human behavior,” in *Proceedings of the 36th Annual ACM Symposium on User Interface Software and Technology*, 2023, pp. 1–22, doi: [10.1145/3586183.3606763](https://doi.org/10.1145/3586183.3606763).

### Streaming, egocentric, and visual engineering systems

[70] P. Zhang *et al.*, “InternLM-XComposer2.5-OmniLive: A Comprehensive Multimodal System for Long-term Streaming Video and Audio Interactions,” arXiv preprint arXiv:2412.09596, 2024, doi: [10.48550/arXiv.2412.09596](https://doi.org/10.48550/arXiv.2412.09596).

[71] X. Zhang *et al.*, “StreamArena: Toward Continuous, Interactive, and Long-Horizon Agentic Streaming Video Understanding,” arXiv preprint arXiv:2608.05703, 2026, doi: [10.48550/arXiv.2608.05703](https://doi.org/10.48550/arXiv.2608.05703).

[72] J. Yang *et al.*, “EgoLife: Towards Egocentric Life Assistant,” in *Proc. IEEE/CVF Conf. Computer Vision and Pattern Recognition (CVPR)*, 2025, pp. 28885–28900, doi: [10.1109/CVPR52734.2025.02690](https://doi.org/10.1109/CVPR52734.2025.02690). Preprint: [arXiv:2503.03803](https://arxiv.org/abs/2503.03803).

[73] R. Xu *et al.*, “StreamingVLM: Real-Time Understanding for Infinite Video Streams,” in *Proc. Int. Conf. Learning Representations (ICLR)*, 2026. [Online]. Available: https://iclr.cc/virtual/2026/poster/10008145. Preprint: arXiv:2510.09608, 2025, doi: [10.48550/arXiv.2510.09608](https://doi.org/10.48550/arXiv.2510.09608) (preprint DOI).

[74] A. Ramachandran *et al.*, “GLIMPSE: Real-Time Text Recognition and Contextual Understanding for VQA in Wearables,” arXiv preprint arXiv:2602.13479, 2026, doi: [10.48550/arXiv.2602.13479](https://doi.org/10.48550/arXiv.2602.13479).

[75] Z. Hu *et al.*, “E²VTS: Energy-Efficient Video Text Spotting From Unmanned Aerial Vehicles,” in *Proc. IEEE/CVF Conf. Computer Vision and Pattern Recognition Workshops (CVPRW)*, 2021, pp. 905–913, doi: [10.1109/CVPRW53098.2021.00101](https://doi.org/10.1109/CVPRW53098.2021.00101). Later preprint: [arXiv:2206.02281](https://arxiv.org/abs/2206.02281), 2022.

[76] Z. Cheng, J. Lu, Y. Niu, S. Pu, F. Wu, and S. Zhou, “You Only Recognize Once: Towards Fast Video Text Spotting,” in *Proc. 27th ACM Int. Conf. Multimedia (MM ’19)*, 2019, pp. 855–863, doi: [10.1145/3343031.3351093](https://doi.org/10.1145/3343031.3351093). Preprint: [arXiv:1903.03299](https://arxiv.org/abs/1903.03299).

[77] N. Keetha *et al.*, “AnyLoc: Towards Universal Visual Place Recognition,” *IEEE Robotics and Automation Letters*, vol. 9, no. 2, pp. 1286–1293, Feb. 2024, doi: [10.1109/LRA.2023.3343602](https://doi.org/10.1109/LRA.2023.3343602). Preprint: [arXiv:2308.00688](https://arxiv.org/abs/2308.00688), 2023.

[78] D. Shan, J. Geng, M. Shu, and D. F. Fouhey, “Understanding human hands in contact at internet scale,” in *Proc. IEEE/CVF Conference on Computer Vision and Pattern Recognition*, 2020, pp. 9866–9875, doi: [10.1109/CVPR42600.2020.00989](https://doi.org/10.1109/CVPR42600.2020.00989).
